/**
 * Semantic index: one vector per BM25 chunk (same chunks, no second split), next to search.json.
 *
 *   embeddings.bin   16-byte header (magic, format, count, stamp), then count × dims Float32
 *   embeddings.json  { format, model, dims, stamp, keys[], files }: keys[i] is the vector at
 *                    offset 16 + i × dims × 4; files[path] lists its chunks' keys
 *
 * A key is the sha256 (first 128 bits) of the text embedded for a chunk, so updates only
 * embed chunks whose text changed: an edit to one function re-embeds that function, a renamed
 * file re-embeds its chunks (the path is part of the text), and vectors no chunk uses any more
 * are dropped on save. Another model means other vectors: the store is rebuilt from scratch.
 *
 * Retrieval is brute force: a dot product with every vector. At 10K chunks × 384 dims that's
 * ~4M multiply-adds, a few milliseconds, and needs no native index; FAISS/HNSW would add a
 * dependency and an approximate answer to save time that isn't being spent.
 */
import { join } from 'node:path';

import { readJson, readText, writeAtomic } from '../utils/fsSafe.ts';
import { readBytes, sha256Hex } from '../utils/runtime.ts';

import type { Chunk } from './chunk.ts';
import { BATCH, type Embedder } from './embed.ts';

import { INDEX_DIR, type LoadedIndex } from './index.ts';

const STORE_JSON = 'embeddings.json';
const STORE_BIN = 'embeddings.bin';
/** Bump when the embedded text or the file layout changes: old stores are rebuilt. */
const FORMAT = 1;
const MAGIC = 0x4d454b43; // "CKEM", little-endian
const HEADER_BYTES = 16; // keeps the vectors 4-byte aligned
/** A long first build saves what it has this often, so a killed process loses little. */
const CHECKPOINT_MS = 30_000;
/** Chunks a server request waits for (an edit or two); more and it answers with keywords. */
const SHORT_UPDATE = 64;

export interface StoreFile {
  size: number;
  mtimeMs: number;
  /** One per chunk, in chunk order. */
  keys: string[];
}

export interface VectorStore {
  model: string;
  dims: number;
  vectors: Map<string, Float32Array>;
  files: Record<string, StoreFile>;
}

interface StoreMeta {
  format: number;
  model: string;
  dims: number;
  stamp: number;
  keys: string[];
  files: Record<string, StoreFile>;
}

export const emptyStore = (model: string, dims: number): VectorStore => ({
  model,
  dims,
  vectors: new Map(),
  files: {},
});

/** What gets embedded for a chunk: where it is, what it declares, then its code. */
export function chunkText(path: string, chunk: Chunk, lines: string[]): string {
  const head = chunk.symbols.length ? `${path}\n${chunk.symbols.join(', ')}` : path;
  return `${head}\n${lines.slice(chunk.start - 1, chunk.end).join('\n')}`;
}

export const textKey = (text: string) => sha256Hex(text).slice(0, 32);

/** The saved store, or an empty one when missing, damaged or made with another model. */
export async function loadStore(root: string, model: string, dims: number): Promise<VectorStore> {
  const dir = join(root, INDEX_DIR);
  const meta = await readJson<StoreMeta>(join(dir, STORE_JSON));
  if (!meta || meta.format !== FORMAT || meta.model !== model || meta.dims !== dims)
    return emptyStore(model, dims);
  let bytes: Uint8Array;
  try {
    bytes = await readBytes(join(dir, STORE_BIN));
  } catch {
    return emptyStore(model, dims);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = meta.keys.length;
  if (
    bytes.byteLength !== HEADER_BYTES + count * dims * 4 ||
    view.getUint32(0, true) !== MAGIC ||
    view.getUint32(4, true) !== FORMAT ||
    view.getUint32(8, true) !== count ||
    view.getUint32(12, true) !== meta.stamp
  )
    return emptyStore(model, dims); // bin and json from different writes
  // Copy once into an aligned buffer; each vector is then a view into it.
  const all = new Float32Array(count * dims);
  new Uint8Array(all.buffer).set(bytes.subarray(HEADER_BYTES));
  const vectors = new Map<string, Float32Array>();
  meta.keys.forEach((k, i) => vectors.set(k, all.subarray(i * dims, (i + 1) * dims)));
  return { model, dims, vectors, files: meta.files ?? {} };
}

/** Writes the vectors some file still uses; bin first, json last (the json names the stamp). */
export async function saveStore(root: string, store: VectorStore): Promise<void> {
  const dir = join(root, INDEX_DIR);
  const used = new Set(Object.values(store.files).flatMap((f) => f.keys));
  const keys = [...store.vectors.keys()].filter((k) => used.has(k));
  const stamp = Math.floor(Math.random() * 0xffffffff);
  const bytes = new Uint8Array(HEADER_BYTES + keys.length * store.dims * 4);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, FORMAT, true);
  view.setUint32(8, keys.length, true);
  view.setUint32(12, stamp, true);
  const floats = new Float32Array(bytes.buffer, HEADER_BYTES);
  keys.forEach((k, i) => floats.set(store.vectors.get(k)!, i * store.dims));
  await writeAtomic(join(dir, '.gitignore'), '*\n');
  await writeAtomic(join(dir, STORE_BIN), bytes);
  const meta: StoreMeta = {
    format: FORMAT,
    model: store.model,
    dims: store.dims,
    stamp,
    keys,
    files: store.files,
  };
  await writeAtomic(join(dir, STORE_JSON), JSON.stringify(meta));
}

/** Bytes on disk of the saved store (for `search --status`). */
export async function storeBytes(root: string): Promise<number> {
  let n = 0;
  for (const f of [STORE_JSON, STORE_BIN]) {
    try {
      n += (await readBytes(join(root, INDEX_DIR, f))).byteLength;
    } catch {
      // not built yet
    }
  }
  return n;
}

/** The store's keys for a file, when they describe its current chunks. */
function currentKeys(
  store: VectorStore,
  path: string,
  entry: LoadedIndex['index']['files'][string],
) {
  const f = store.files[path];
  return f &&
    f.size === entry.size &&
    f.mtimeMs === entry.mtimeMs &&
    f.keys.length === entry.chunks.length
    ? f.keys
    : null;
}

export interface Progress {
  /** Chunks that have a vector. */
  done: number;
  total: number;
}

/** Chunks of `loaded` with a vector in `store`, out of all its chunks. */
export function coverage(loaded: LoadedIndex, store: VectorStore): Progress {
  let done = 0;
  let total = 0;
  for (const [path, entry] of Object.entries(loaded.index.files)) {
    total += entry.chunks.length;
    const keys = currentKeys(store, path, entry);
    if (keys) for (const k of keys) if (store.vectors.has(k)) done++;
  }
  return { done, total };
}

/**
 * Brings `store` up to date with `loaded`: reuses every vector whose text is unchanged, embeds
 * the rest in batches, forgets files that are gone. Mutates and returns `store` (a fresh one if
 * the model changed), saving it at checkpoints and at the end.
 */
export async function updateVectors(
  loaded: LoadedIndex,
  embedder: Embedder,
  previous: VectorStore,
  opts: {
    onProgress?: (p: Progress) => void;
    save?: (store: VectorStore) => Promise<void>;
    checkpointMs?: number;
  } = {},
): Promise<VectorStore> {
  const store =
    previous.model === embedder.model && previous.dims === embedder.dims
      ? previous
      : emptyStore(embedder.model, embedder.dims);
  const save = opts.save ?? ((s: VectorStore) => saveStore(loaded.root, s));
  const files: Record<string, StoreFile> = {};
  /** Missing key → its text and how many chunks wait for it. */
  const missing = new Map<string, { text: string; uses: number }>();
  let done = 0;
  let total = 0;
  let changed = Object.keys(store.files).some((p) => !(p in loaded.index.files));

  for (const [path, entry] of Object.entries(loaded.index.files)) {
    total += entry.chunks.length;
    let keys = currentKeys(store, path, entry);
    let texts: string[] | null = null;
    // Changed file, or vectors lost since its keys were saved (a checkpoint): read the text.
    if (!keys || keys.some((k) => !store.vectors.has(k))) {
      changed ||= !keys;
      const lines = ((await readText(join(loaded.root, path))) ?? '').split('\n');
      texts = entry.chunks.map((c) => chunkText(path, c, lines));
      keys = texts.map(textKey);
    }
    files[path] = { size: entry.size, mtimeMs: entry.mtimeMs, keys };
    keys.forEach((k, i) => {
      if (store.vectors.has(k)) return void done++;
      const m = missing.get(k);
      if (m) m.uses++;
      else missing.set(k, { text: texts![i]!, uses: 1 });
    });
  }
  store.files = files;
  opts.onProgress?.({ done, total });

  // Similar lengths per batch: a batch is padded to its longest text, so mixing a one-liner
  // with a 512-token function makes the one-liner cost 512 tokens.
  const todo = [...missing.entries()].sort((a, b) => a[1].text.length - b[1].text.length);
  let lastSave = Date.now();
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const vectors = await embedder.embed(
      batch.map(([, m]) => m.text),
      'passage',
    );
    batch.forEach(([k, m], j) => {
      store.vectors.set(k, vectors[j]!);
      done += m.uses;
    });
    opts.onProgress?.({ done, total });
    if (Date.now() - lastSave > (opts.checkpointMs ?? CHECKPOINT_MS) && i + BATCH < todo.length) {
      await save(store);
      lastSave = Date.now();
    }
  }
  if (changed || todo.length) {
    const used = new Set(Object.values(files).flatMap((f) => f.keys));
    for (const k of store.vectors.keys()) if (!used.has(k)) store.vectors.delete(k);
    await save(store);
  }
  return store;
}

export interface ChunkVectorHit {
  path: string;
  /** Index into the file's chunks. */
  chunk: number;
  similarity: number;
}

/** Cosine similarity of the query with every chunk that has a current vector, best first. */
export function vectorSearch(
  loaded: LoadedIndex,
  store: VectorStore,
  query: Float32Array,
  keep: (path: string) => boolean = () => true,
): ChunkVectorHit[] {
  const memo = new Map<string, number>();
  const hits: ChunkVectorHit[] = [];
  for (const [path, entry] of Object.entries(loaded.index.files)) {
    if (!keep(path)) continue;
    const keys = currentKeys(store, path, entry);
    if (!keys) continue;
    keys.forEach((k, chunk) => {
      let sim = memo.get(k);
      if (sim === undefined) {
        const v = store.vectors.get(k);
        if (!v) return;
        sim = 0;
        for (let d = 0; d < v.length; d++) sim += v[d]! * query[d]!;
        memo.set(k, sim);
      }
      hits.push({ path, chunk, similarity: sim });
    });
  }
  return hits.sort((a, b) => b.similarity - a.similarity);
}

export interface SemanticState {
  /** Every chunk of the last requested index has a vector. */
  ready: boolean;
  done: number;
  total: number;
  /** Why semantic search is unavailable (runtime or model missing, load failure). */
  error?: string;
}

/**
 * One project's semantic index inside a long-lived process (the MCP server) or a CLI run: loads
 * the model and the saved store once, and runs at most one build at a time (later requests join
 * it, then catch up with the newest index).
 */
export class SemanticIndex {
  state: SemanticState = { ready: false, done: 0, total: 0 };
  private embedder?: Promise<Embedder>;
  private store?: VectorStore;
  private building?: Promise<void>;
  private target?: LoadedIndex;

  constructor(
    readonly root: string,
    readonly model: string,
    private readonly load: (model: string) => Promise<Embedder>,
    private readonly opts: { onProgress?: (p: Progress) => void; checkpointMs?: number } = {},
  ) {}

  private getEmbedder(): Promise<Embedder> {
    this.embedder ??= this.load(this.model).catch((err: unknown) => {
      this.embedder = undefined; // retried on the next request (e.g. after --setup)
      throw err;
    });
    return this.embedder;
  }

  /** True when every chunk of `loaded` has a vector in memory. */
  covers(loaded: LoadedIndex): boolean {
    if (!this.store) return false;
    const { done, total } = coverage(loaded, this.store);
    return done === total;
  }

  /** Embeds whatever `loaded` lacks; resolves once the store covers the newest request. */
  refresh(loaded: LoadedIndex): Promise<{ store: VectorStore; embedder: Embedder }> {
    this.target = loaded;
    this.building ??= (async () => {
      try {
        while (this.target && !this.covers(this.target)) {
          const target = this.target;
          await this.build(target);
          // Covered, or a newer index arrived meanwhile; never spin on one that can't be.
          if (this.target === target) break;
        }
      } finally {
        this.building = undefined;
      }
    })();
    return this.building.then(async () => ({
      store: this.store!,
      embedder: await this.getEmbedder(),
    }));
  }

  private async build(loaded: LoadedIndex): Promise<void> {
    try {
      const embedder = await this.getEmbedder();
      this.store ??= await loadStore(this.root, embedder.model, embedder.dims);
      this.store = await updateVectors(loaded, embedder, this.store, {
        checkpointMs: this.opts.checkpointMs,
        onProgress: (p) => {
          this.state = { ready: p.done === p.total, ...p };
          this.opts.onProgress?.(p);
        },
      });
      this.state = { ...this.state, ready: this.covers(loaded), error: undefined };
    } catch (err) {
      this.state = { ...this.state, ready: false, error: (err as Error).message };
      throw err;
    }
  }

  /**
   * For servers: the store and model if they cover `loaded` within `waitMs`, else null while a
   * build continues in the background (`state` reports its progress).
   */
  async whenReady(
    loaded: LoadedIndex,
    waitMs: number,
  ): Promise<{ store: VectorStore; embedder: Embedder } | null> {
    if (this.covers(loaded) && this.embedder) {
      this.state = { ...this.state, ready: true };
      return { store: this.store!, embedder: await this.embedder };
    }
    const built = this.refresh(loaded).catch(() => null);
    // A long build won't finish within the wait: answer now rather than after waitMs.
    const { done, total } = this.state;
    if (this.building && total - done > SHORT_UPDATE) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), waitMs);
    });
    const result = await Promise.race([built, timeout]);
    clearTimeout(timer);
    return result && this.covers(loaded) ? result : null;
  }
}
