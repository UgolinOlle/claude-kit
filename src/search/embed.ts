/**
 * Optional embeddings runtime for semantic code search. transformers.js (and its native
 * onnxruntime-node) is never a dependency of claude-kit: `claude-kit search --setup` installs it
 * into a per-user cache shared by every project, and it is loaded from there with a computed
 * file URL, so the bundler can't inline it and the default install stays as small as before.
 *
 *   ~/.cache/claude-kit/embeddings/              ($CLAUDE_KIT_CACHE_DIR/embeddings)
 *     package.json, node_modules/                @huggingface/transformers, pinned
 *     models/<org>/<model>/                       downloaded weights (only by --setup)
 */
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import { fileExists, readFileText, runVisible, which, writeFile } from '../utils/runtime.ts';

/** Pinned: a new version is a deliberate claude-kit release, not a surprise on a user's machine. */
export const TRANSFORMERS_PACKAGE = '@huggingface/transformers';
export const TRANSFORMERS_VERSION = '4.3.1';
/** Rough figures shown before installing, measured on macOS arm64. */
export const RUNTIME_DISK_MB = 480;

export interface EmbeddingModel {
  id: string;
  dims: number;
  /** Prepended to queries and passages: e5 models are trained with them. */
  prefix: { query: string; passage: string };
  /** Size of the quantized ONNX weights plus tokenizer. */
  downloadMB: number;
  languages: string;
  /**
   * Best query–chunk cosine below which nothing in the project is about the query, measured
   * with scripts/search-eval.ts on Whoa Jobs (27 answered, 4 unanswered queries). Scales differ
   * between models. The ranges overlap, so each value sits just under the lowest answered query:
   * it catches the clearly off-topic half of unanswered queries without hiding a real answer.
   * Queries whose words all appear in one file are never rejected (see searchDetailed).
   */
  minSimilarity?: number;
}

/** `dtype: 'q8'` (model_quantized.onnx): a quarter of fp32's size, near-identical rankings. */
export const MODELS: Record<string, EmbeddingModel> = {
  'Xenova/multilingual-e5-small': {
    id: 'Xenova/multilingual-e5-small',
    dims: 384,
    prefix: { query: 'query: ', passage: 'passage: ' },
    downloadMB: 135,
    languages: 'multilingual (~100 languages)',
    // Whoa Jobs: answered queries' best chunk 0.839–0.900, unanswered 0.831–0.858.
    minSimilarity: 0.835,
  },
  'Xenova/paraphrase-multilingual-MiniLM-L12-v2': {
    id: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
    dims: 384,
    prefix: { query: '', passage: '' },
    downloadMB: 135,
    languages: 'multilingual (50+ languages)',
    // Whoa Jobs: answered 0.418–0.739, unanswered 0.348–0.563.
    minSimilarity: 0.4,
  },
  'Xenova/all-MiniLM-L6-v2': {
    id: 'Xenova/all-MiniLM-L6-v2',
    dims: 384,
    prefix: { query: '', passage: '' },
    downloadMB: 24,
    languages: 'English',
    // Whoa Jobs: answered 0.283–0.639, unanswered 0.207–0.468.
    minSimilarity: 0.275,
  },
};
export const DEFAULT_MODEL = 'Xenova/multilingual-e5-small';
/**
 * Texts per inference. 8 texts of 512 tokens take ~0.5 s with the same throughput as 32 (ONNX
 * already uses every core), and a query queued behind a build batch waits at most that long.
 */
export const BATCH = 8;

export interface Embedder {
  model: string;
  dims: number;
  /** See EmbeddingModel.minSimilarity. */
  minSimilarity?: number;
  /** Unit-length vectors, so cosine similarity is a dot product. */
  embed(texts: string[], kind: 'query' | 'passage'): Promise<Float32Array[]>;
}

export class SetupError extends Error {}

const SETUP_HINT = 'run `claude-kit search --setup`';

export function cacheDir(): string {
  const base = process.env.CLAUDE_KIT_CACHE_DIR || join(homedir(), '.cache', 'claude-kit');
  return join(base, 'embeddings');
}

export const modelsDir = () => join(cacheDir(), 'models');

/** Installed version of the runtime in the cache, or null. */
export async function runtimeVersion(): Promise<string | null> {
  const text = await readFileText(
    join(cacheDir(), 'node_modules', ...TRANSFORMERS_PACKAGE.split('/'), 'package.json'),
  );
  if (!text) return null;
  try {
    return String((JSON.parse(text) as { version?: unknown }).version ?? '') || null;
  } catch {
    return null;
  }
}

/**
 * Installs the pinned runtime into the cache (npm, or Bun when npm is missing). Lifecycle
 * scripts are skipped: onnxruntime-node and sharp ship prebuilt binaries in their packages.
 * Never touches the project.
 */
export async function installRuntime(): Promise<void> {
  const dir = cacheDir();
  const pkg = `${TRANSFORMERS_PACKAGE}@${TRANSFORMERS_VERSION}`;
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'claude-kit-embeddings', private: true }, null, 2) + '\n',
  );
  const npm = which('npm');
  const [cmd, args] = npm
    ? [
        npm,
        [
          'install',
          '--prefix',
          dir,
          '--save-exact',
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          pkg,
        ],
      ]
    : [which('bun'), ['add', '--cwd', dir, '--exact', '--ignore-scripts', pkg]];
  if (!cmd)
    throw new Error('Installing the embeddings runtime needs npm (Node.js) or Bun on PATH.');
  const code = await runVisible(cmd, args as string[], { cwd: dir });
  if (code !== 0) throw new Error(`Installing ${pkg} into ${dir} failed (exit ${code}).`);
}

/** True when the model's quantized weights are in the cache (downloaded by --setup). */
export function modelDownloaded(model: string): Promise<boolean> {
  return fileExists(join(modelsDir(), ...model.split('/'), 'onnx', 'model_quantized.onnx'));
}

interface Transformers {
  env: {
    cacheDir: string | null;
    localModelPath: string;
    allowRemoteModels: boolean;
    allowLocalModels: boolean;
  };
  pipeline(
    task: 'feature-extraction',
    model: string,
    opts: { dtype: string },
  ): Promise<
    (
      texts: string[],
      opts: { pooling: 'mean'; normalize: boolean },
    ) => Promise<{ data: Float32Array; dims: number[] }>
  >;
}

/** Resolved entry file of the cached runtime. */
function runtimeEntry(): string {
  try {
    return createRequire(join(cacheDir(), 'package.json')).resolve(TRANSFORMERS_PACKAGE);
  } catch {
    throw new SetupError(`The embeddings runtime isn't installed: ${SETUP_HINT}.`);
  }
}

function runtimeFailure(err: unknown): string {
  const why = (err as Error)?.message ?? String(err);
  const bun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
  return `The embeddings runtime failed to load: ${why}. ${
    bun
      ? 'onnxruntime-node is only supported on Node: if this persists, run claude-kit with Node (npx @whoa-studio/claude-kit …, or "command": "npx" for code-search in .mcp.json).'
      : `Reinstall it: ${SETUP_HINT}.`
  }`;
}

/** Flat Float32 output of one batch: texts.length × dims. */
type Extract = (texts: string[]) => Promise<Float32Array>;

interface PipelineOptions {
  url: string;
  models: string;
  model: string;
  allowDownload: boolean;
}

/** Loads the pipeline on this thread: fastest, but inference blocks it (CLI, --setup). */
async function threadPipeline(o: PipelineOptions): Promise<Extract> {
  let tf: Transformers;
  try {
    // A computed URL: the bundler can't follow it, so transformers never enters the bundle.
    const mod = (await import(o.url)) as Transformers & { default?: Transformers };
    tf = typeof mod.pipeline === 'function' ? mod : mod.default!;
    // Downloads land in models/ with the same <org>/<model>/ layout local models are read from.
    tf.env.cacheDir = o.models;
    tf.env.localModelPath = o.models;
    tf.env.allowLocalModels = true;
    tf.env.allowRemoteModels = o.allowDownload;
    const extract = await tf.pipeline('feature-extraction', o.model, { dtype: 'q8' });
    return async (texts) => (await extract(texts, { pooling: 'mean', normalize: true })).data;
  } catch (err) {
    throw new SetupError(runtimeFailure(err));
  }
}

/** The same steps as threadPipeline, inside a worker (CommonJS: eval'd workers run as scripts). */
const WORKER_SOURCE = `
const { parentPort, workerData: o } = require('node:worker_threads');
(async () => {
  const mod = await import(o.url);
  const tf = typeof mod.pipeline === 'function' ? mod : mod.default;
  tf.env.cacheDir = o.models;
  tf.env.localModelPath = o.models;
  tf.env.allowLocalModels = true;
  tf.env.allowRemoteModels = o.allowDownload;
  const extract = await tf.pipeline('feature-extraction', o.model, { dtype: 'q8' });
  parentPort.on('message', async ({ id, texts }) => {
    try {
      const { data } = await extract(texts, { pooling: 'mean', normalize: true });
      parentPort.postMessage({ id, data }, [data.buffer]);
    } catch (err) {
      parentPort.postMessage({ id, error: String((err && err.message) || err) });
    }
  });
  parentPort.postMessage({ ready: true });
})().catch((err) => parentPort.postMessage({ error: String((err && err.message) || err) }));
`;

/**
 * Loads the pipeline in a worker thread, so the calling thread stays free while a long build
 * runs (the MCP server keeps answering). Inference is ~30% slower there than on the main thread.
 */
async function workerPipeline(o: PipelineOptions): Promise<Extract> {
  const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: o });
  worker.unref(); // never keeps the process alive on its own
  const pending = new Map<number, { resolve(d: Float32Array): void; reject(e: Error): void }>();
  const failAll = (err: Error) => {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };
  await new Promise<void>((resolve, reject) => {
    worker.once('message', (m: { ready?: boolean; error?: string }) =>
      m.ready ? resolve() : reject(new SetupError(runtimeFailure(m.error))),
    );
    worker.once('error', (err) => reject(new SetupError(runtimeFailure(err))));
  });
  worker.on('message', (m: { id: number; data?: Float32Array; error?: string }) => {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error !== undefined) p?.reject(new Error(m.error));
    else p?.resolve(m.data!);
  });
  worker.on('error', failAll);
  worker.on('exit', () => failAll(new Error('The embeddings worker stopped.')));
  let next = 0;
  return (texts) =>
    new Promise((resolve, reject) => {
      pending.set(++next, { resolve, reject });
      // A worker_threads port, not window.postMessage: there's no origin to target.
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      worker.postMessage({ id: next, texts });
    });
}

/**
 * The model as an Embedder. Without `allowDownload` only cached weights are used, so nothing is
 * ever fetched behind the user's back: --setup is the one place that passes it. `worker` runs
 * inference off the calling thread (servers).
 */
export async function loadEmbedder(
  model: string,
  opts: { allowDownload?: boolean; worker?: boolean } = {},
): Promise<Embedder> {
  const spec = MODELS[model];
  if (!spec) throw new Error(`Unknown embeddings model "${model}".`);
  if (!opts.allowDownload && !(await modelDownloaded(model)))
    throw new SetupError(`The embeddings model ${model} isn't downloaded: ${SETUP_HINT}.`);
  const o: PipelineOptions = {
    url: pathToFileURL(runtimeEntry()).href,
    models: modelsDir(),
    model,
    allowDownload: opts.allowDownload === true,
  };
  const extract = await (opts.worker ? workerPipeline(o) : threadPipeline(o));
  // One inference at a time: a query waits for the current batch instead of competing with it.
  let queue: Promise<unknown> = Promise.resolve();
  const run = (texts: string[]) => {
    const next = queue.then(() => extract(texts));
    queue = next.catch(() => undefined);
    return next;
  };
  return {
    model,
    dims: spec.dims,
    minSimilarity: spec.minSimilarity,
    async embed(texts, kind) {
      const prefix = spec.prefix[kind];
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += BATCH) {
        // The tokenizer truncates each text to the model's maximum length (512 tokens).
        const batch = texts.slice(i, i + BATCH).map((t) => prefix + t);
        const data = await run(batch);
        for (let j = 0; j < batch.length; j++)
          out.push(data.slice(j * spec.dims, (j + 1) * spec.dims));
      }
      return out;
    },
  };
}
