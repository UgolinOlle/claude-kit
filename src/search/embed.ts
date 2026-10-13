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
   * with scripts/search-eval.ts. Cosine scales differ between models; unset = not calibrated,
   * search never answers "no relevant match".
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
  },
  'Xenova/paraphrase-multilingual-MiniLM-L12-v2': {
    id: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
    dims: 384,
    prefix: { query: '', passage: '' },
    downloadMB: 135,
    languages: 'multilingual (50+ languages)',
  },
  'Xenova/all-MiniLM-L6-v2': {
    id: 'Xenova/all-MiniLM-L6-v2',
    dims: 384,
    prefix: { query: '', passage: '' },
    downloadMB: 24,
    languages: 'English',
  },
};
export const DEFAULT_MODEL = 'Xenova/multilingual-e5-small';
const BATCH = 32;

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

async function importRuntime(): Promise<Transformers> {
  let entry: string;
  try {
    entry = createRequire(join(cacheDir(), 'package.json')).resolve(TRANSFORMERS_PACKAGE);
  } catch {
    throw new SetupError(`The embeddings runtime isn't installed: ${SETUP_HINT}.`);
  }
  try {
    // A computed URL: the bundler can't follow it, so transformers never enters the bundle.
    const mod = (await import(pathToFileURL(entry).href)) as Transformers & {
      default?: Transformers;
    };
    return typeof mod.pipeline === 'function' ? mod : mod.default!;
  } catch (err) {
    throw new SetupError(runtimeFailure(err));
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

/**
 * The model as an Embedder. Without `allowDownload` only cached weights are used, so nothing is
 * ever fetched behind the user's back: --setup is the one place that passes it.
 */
export async function loadEmbedder(
  model: string,
  opts: { allowDownload?: boolean } = {},
): Promise<Embedder> {
  const spec = MODELS[model];
  if (!spec) throw new Error(`Unknown embeddings model "${model}".`);
  if (!opts.allowDownload && !(await modelDownloaded(model)))
    throw new SetupError(`The embeddings model ${model} isn't downloaded: ${SETUP_HINT}.`);
  const tf = await importRuntime();
  // Downloads land in models/ with the same <org>/<model>/ layout local models are read from.
  tf.env.cacheDir = modelsDir();
  tf.env.localModelPath = modelsDir();
  tf.env.allowLocalModels = true;
  tf.env.allowRemoteModels = opts.allowDownload === true;
  let extract;
  try {
    extract = await tf.pipeline('feature-extraction', model, { dtype: 'q8' });
  } catch (err) {
    throw new SetupError(runtimeFailure(err));
  }
  // One inference at a time: a query waits for the current batch instead of competing with it.
  let queue: Promise<unknown> = Promise.resolve();
  const run = (texts: string[]) => {
    const next = queue.then(() => extract(texts, { pooling: 'mean', normalize: true }));
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
        const { data } = await run(batch);
        for (let j = 0; j < batch.length; j++)
          out.push(data.slice(j * spec.dims, (j + 1) * spec.dims));
      }
      return out;
    },
  };
}
