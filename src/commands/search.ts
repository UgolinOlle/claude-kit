/**
 * Code search (#7) for humans and for Claude:
 *   claude-kit search <query…> [--limit 5] [--path dir] [--code] [--mode m]   ranked results
 *   claude-kit search --related <file>                               imports, importers, tests
 *   claude-kit search --setup | --status                             optional semantic search
 *   claude-kit serve search                                          the `code-search` MCP server
 */
import { resolve } from 'node:path';

import type { GlobalOptions } from '../cli.ts';
import { CONFIG_PATH, type EmbeddingsConfig, loadConfig } from '../core/config.ts';
import { VERSION } from '../data/package.ts';
import { SEARCH_SERVER } from '../generators/search.ts';
import { type McpTool, serveStdio } from '../mcp/stdioServer.ts';
import {
  cacheDir,
  DEFAULT_MODEL,
  type Embedder,
  installRuntime,
  loadEmbedder,
  modelDownloaded,
  MODELS,
  RUNTIME_DISK_MB,
  runtimeVersion,
  TRANSFORMERS_PACKAGE,
  TRANSFORMERS_VERSION,
} from '../search/embed.ts';
import { type LoadedIndex, updateIndex } from '../search/index.ts';
import {
  related,
  SEARCH_MODES,
  type SearchMode,
  type SearchOutcome,
  searchDetailed,
  type SemanticContext,
} from '../search/query.ts';
import { coverage, loadStore, SemanticIndex, storeBytes } from '../search/semantic.ts';
import { c, configureLogger, log } from '../utils/logger.ts';

import { askOnTerminal } from './compress.ts';

/**
 * How long a `search_code` call waits for the semantic index (model load, a few changed
 * chunks) before answering with keywords only while the build goes on in the background.
 */
const SERVER_WAIT_MS = 1500;

export interface SearchDeps {
  /** Overrides loading the embeddings model (tests). */
  loadEmbedder?: (
    model: string,
    opts?: { allowDownload?: boolean; worker?: boolean },
  ) => Promise<Embedder>;
  /** Overrides installing the runtime (tests). */
  install?: () => Promise<void>;
  /** Answers the --setup consent question (tests); default asks on the terminal, null = no terminal. */
  confirm?: ((question: string) => Promise<boolean>) | null;
  /** Overrides what --setup checks is already there (tests). */
  installed?: (model: string) => Promise<{ runtime: boolean; model: boolean }>;
  /** Overrides SERVER_WAIT_MS (tests). */
  waitMs?: number;
}

function formatResults(out: SearchOutcome, loaded: LoadedIndex, note?: string): string {
  const s = loaded.stats;
  const footer = `(${s.files} files indexed${s.updated ? `, ${s.updated} updated` : ''}${note ? `; ${note}` : ''})`;
  if (out.noRelevantMatch)
    return `No relevant match: nothing in this project is close to that (best similarity ${out.bestSimilarity?.toFixed(3)}). It may not exist here; try the exact identifier or error text if you know it.\n${footer}`;
  if (out.results.length === 0)
    return `No matches. Try other words (identifiers, error text) or a broader path.\n${footer}`;
  const lines = out.results.map((r, i) => {
    const chunks = r.chunks
      .map((h) => `L${h.lines}${h.symbols.length ? ` ${h.symbols.join(', ')}` : ''}`)
      .join(' · ');
    const lines = [`${i + 1}. ${r.path} (${r.score.toFixed(2)})`, `   ${chunks}`];
    if (r.related.length) lines.push(`   related: ${r.related.join(', ')}`);
    if (r.code) lines.push('```', r.code, '```');
    return lines.join('\n');
  });
  lines.push(footer);
  return lines.join('\n');
}

function formatRelated(loaded: LoadedIndex, path: string): string {
  const r = related(loaded, path);
  if (!r.indexed)
    return `${r.path} isn't in the index (missing, binary, too large or excluded by .claudeignore).`;
  const list = (xs: string[]) => (xs.length ? xs.join(', ') : '—');
  return [
    r.path,
    `imports:     ${list(r.imports)}`,
    `imported by: ${list(r.importedBy)}`,
    `tests:       ${list(r.tests)}`,
  ].join('\n');
}

const int = (v: unknown, def: number, min: number, max: number) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def;
};

/**
 * One SemanticIndex per process, rebuilt if the configured model changes. The server loads the
 * model in a worker thread: on the main thread, inference would block request handling.
 */
export function semanticIndexes(root: string, deps: SearchDeps = {}) {
  let current: SemanticIndex | undefined;
  const load = deps.loadEmbedder ?? ((m: string) => loadEmbedder(m, { worker: true }));
  return (model: string): SemanticIndex => {
    if (current?.model !== model) current = new SemanticIndex(root, model, (m) => load(m));
    return current;
  };
}

/**
 * The semantic side of a server query: vectors when the index covers the project within the
 * wait, else null plus a footer note saying why the answer is keyword-only.
 */
async function serverSemantic(
  loaded: LoadedIndex,
  emb: EmbeddingsConfig,
  index: SemanticIndex,
  waitMs: number,
): Promise<{ semantic?: SemanticContext; note?: string }> {
  const ready = await index.whenReady(loaded, waitMs);
  if (ready) return { semantic: { ...ready, weights: emb.weights } };
  const { error, done, total } = index.state;
  if (error) return { note: `semantic search unavailable: ${error}` };
  const pct = total ? Math.floor((100 * done) / total) : 0;
  return { note: `semantic index: ${pct}% built, keyword results` };
}

/** Tool definitions are loaded into every session: keep descriptions short and exact. */
export function searchTools(
  root: string,
  deps: SearchDeps = {},
  semanticFor = semanticIndexes(root, deps),
): McpTool[] {
  return [
    {
      name: 'search_code',
      description:
        'Ranked search over this project\'s code and docs, by function, class and section. Use it for "where is X handled / defined / configured" before grepping or opening files. Returns files with the matching line ranges and symbols, plus import-graph neighbours; then read only those ranges. Never returns files excluded by .claudeignore.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'What to find: identifiers, concepts, error text',
          },
          k: {
            type: 'integer',
            minimum: 1,
            maximum: 20,
            default: 5,
            description: 'Number of files',
          },
          path: {
            type: 'string',
            description: 'Only under this directory or glob',
          },
          include_code: {
            type: 'boolean',
            default: false,
            description: 'Also return the best-matching chunk of each file (numbered lines)',
          },
          max_tokens: {
            type: 'integer',
            default: 4000,
            description: 'Budget for include_code; lower-ranked chunks are dropped first',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
      async handler(args) {
        const query = typeof args.query === 'string' ? args.query.trim() : '';
        if (!query) throw new Error('query is required');
        const config = await loadConfig(root);
        const loaded = await updateIndex(root);
        const emb = config.search.embeddings;
        const { semantic, note } = emb.enabled
          ? await serverSemantic(loaded, emb, semanticFor(emb.model), deps.waitMs ?? SERVER_WAIT_MS)
          : {};
        const out = await searchDetailed(loaded, query, {
          k: int(args.k, 5, 1, 20),
          path: typeof args.path === 'string' ? args.path : undefined,
          includeCode: args.include_code === true,
          // The project's retrieved_context budget (#12) caps what one call can pull in.
          maxTokens: int(args.max_tokens, 4000, 200, config.budgets.retrieved_context),
          semantic,
        });
        return formatResults(out, loaded, note);
      },
    },
    {
      name: 'related_files',
      description:
        'For one project file: what it imports, what imports it, and tests that look like they cover it. Use before changing a file to find its callers and tests.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Project-relative file path' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      async handler(args) {
        if (typeof args.path !== 'string' || !args.path) throw new Error('path is required');
        return formatRelated(await updateIndex(root), args.path);
      },
    },
  ];
}

export async function runServe(
  opts: GlobalOptions,
  args: string[],
  deps: SearchDeps = {},
): Promise<number> {
  if (args[0] !== 'search') {
    log.error('Usage: claude-kit serve search   (MCP server over stdio; started by Claude Code)');
    return 2;
  }
  configureLogger({ silent: true }); // stdout belongs to the protocol
  // Responses are written to process.stdout directly; a library logging with console.log
  // (the embeddings runtime) must not interleave with them.
  console.log = console.error;
  const root = resolve(process.env.CLAUDE_PROJECT_DIR || opts.cwd);
  const semanticFor = semanticIndexes(root, deps);
  // Start the semantic build with the session, not on the first query; errors are reported
  // by search_code's footer.
  void (async () => {
    const emb = (await loadConfig(root)).search.embeddings;
    if (emb.enabled) await semanticFor(emb.model).refresh(await updateIndex(root));
  })().catch(() => undefined);
  await serveStdio({ name: SEARCH_SERVER, version: VERSION }, searchTools(root, deps, semanticFor));
  return 0;
}

/** Progress on stderr: a rewritten line on a terminal, start and end lines otherwise. */
function progressReporter(label: string) {
  const tty = process.stderr.isTTY;
  let last = -1;
  return {
    update(done: number, total: number) {
      const pct = total ? Math.floor((100 * done) / total) : 100;
      if (pct === last || (last === -1 && done === total)) return;
      if (tty) process.stderr.write(`\r${label}: ${done}/${total} chunks (${pct}%)`);
      else if (last === -1) process.stderr.write(`${label}: ${total - done} chunks to embed…\n`);
      last = pct;
    },
    end() {
      if (tty && last !== -1) process.stderr.write('\n');
    },
  };
}

async function buildSemantic(
  root: string,
  loaded: LoadedIndex,
  model: string,
  load: (model: string) => Promise<Embedder>,
) {
  const progress = progressReporter('semantic index');
  const index = new SemanticIndex(root, model, load, {
    onProgress: (p) => progress.update(p.done, p.total),
  });
  try {
    return await index.refresh(loaded);
  } finally {
    progress.end();
  }
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function runSetup(opts: GlobalOptions, deps: SearchDeps): Promise<number> {
  const root = resolve(opts.cwd);
  const config = await loadConfig(root);
  const model = opts.model ?? config.search.embeddings.model;
  if (!MODELS[model]) {
    log.error(`Unknown embeddings model "${model}". Supported: ${Object.keys(MODELS).join(', ')}.`);
    return 2;
  }
  const have = deps.installed
    ? await deps.installed(model)
    : {
        runtime: (await runtimeVersion()) === TRANSFORMERS_VERSION,
        model: await modelDownloaded(model),
      };
  const downloads: string[] = [];
  if (!have.runtime)
    downloads.push(
      `${TRANSFORMERS_PACKAGE}@${TRANSFORMERS_VERSION} and onnxruntime-node from the npm registry (~${RUNTIME_DISK_MB} MB on disk)`,
    );
  if (!have.model)
    downloads.push(`the ${model} model from huggingface.co (~${MODELS[model]!.downloadMB} MB)`);
  if (downloads.length) {
    const question = [
      'Semantic search downloads:',
      ...downloads.map((d) => `  - ${d}`),
      `into ${cacheDir()} (shared by all projects; delete it to uninstall). Your project's files and package.json are not changed, and code is embedded locally: nothing is sent anywhere.`,
      'Download now?',
    ].join('\n');
    const confirm =
      deps.confirm === undefined ? (process.stdin.isTTY ? askOnTerminal : null) : deps.confirm;
    if (!opts.yes) {
      if (!confirm) {
        log.error(`${question}\nNot a terminal: pass --yes to confirm.`);
        return 2;
      }
      if (!(await confirm(question))) {
        log.info('Cancelled; nothing was downloaded.');
        return 1;
      }
    }
  }
  if (!have.runtime) {
    log.info(`Installing ${TRANSFORMERS_PACKAGE}@${TRANSFORMERS_VERSION} into ${cacheDir()}…`);
    await (deps.install ?? installRuntime)();
  }
  if (!have.model) log.info(`Downloading ${model}…`);
  const embedder = await (deps.loadEmbedder ?? loadEmbedder)(model, { allowDownload: true });

  const t0 = Date.now();
  const loaded = await updateIndex(root);
  await buildSemantic(root, loaded, model, async () => embedder);
  log.success(
    `Semantic index of ${loaded.stats.chunks} chunks ready in ${((Date.now() - t0) / 1000).toFixed(0)} s (${mb(await storeBytes(root))} in .claude-kit/index/).`,
  );
  const emb = config.search.embeddings;
  if (!emb.enabled || emb.model !== model) {
    const snippet =
      model === DEFAULT_MODEL
        ? '"search": { "embeddings": { "enabled": true } }'
        : `"search": { "embeddings": { "enabled": true, "model": "${model}" } }`;
    log.info(
      `Turn it on for search_code and \`claude-kit search\`: add ${c.bold(snippet)} to ${CONFIG_PATH}.`,
    );
  }
  return 0;
}

async function runStatus(opts: GlobalOptions): Promise<number> {
  const root = resolve(opts.cwd);
  const emb = (await loadConfig(root)).search.embeddings;
  const version = await runtimeVersion();
  const downloaded = await modelDownloaded(emb.model);
  const loaded = await updateIndex(root);
  const store = await loadStore(root, emb.model, MODELS[emb.model]!.dims);
  const { done, total } = coverage(loaded, store);
  const bytes = await storeBytes(root);
  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          enabled: emb.enabled,
          model: emb.model,
          weights: emb.weights,
          runtime: version,
          modelDownloaded: downloaded,
          cacheDir: cacheDir(),
          chunks: { embedded: done, total },
          bytes,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  const setup = c.dim('→ claude-kit search --setup');
  log.info(
    [
      `semantic search  ${emb.enabled ? c.green('enabled') : `disabled ${c.dim(`(${CONFIG_PATH}: "search": { "embeddings": { "enabled": true } })`)}`}`,
      `runtime          ${version ? `${TRANSFORMERS_PACKAGE} ${version}${version === TRANSFORMERS_VERSION ? '' : c.yellow(` (expected ${TRANSFORMERS_VERSION})`)}` : `not installed ${setup}`}`,
      `model            ${emb.model}${downloaded ? '' : ` — not downloaded ${setup}`}`,
      `cache            ${cacheDir()}`,
      `index            ${done}/${total} chunks embedded (${total ? Math.floor((100 * done) / total) : 0}%), ${mb(bytes)} on disk`,
    ].join('\n'),
  );
  return 0;
}

export async function runSearch(
  opts: GlobalOptions,
  words: string[],
  deps: SearchDeps = {},
): Promise<number> {
  const root = resolve(opts.cwd);
  if (opts.setup) return runSetup(opts, deps);
  if (opts.status) return runStatus(opts);
  if (opts.related) {
    const loaded = await updateIndex(root);
    if (opts.json) console.log(JSON.stringify(related(loaded, opts.related), null, 2));
    else log.info(formatRelated(loaded, opts.related));
    return 0;
  }
  const query = words.join(' ').trim();
  if (!query) {
    log.error(
      'Usage: claude-kit search <query…> [--limit 5] [--path dir] [--code] [--mode keyword|semantic|hybrid]  |  --related <file>  |  --setup  |  --status',
    );
    return 2;
  }
  if (opts.mode !== undefined && !SEARCH_MODES.includes(opts.mode as SearchMode)) {
    log.error(`Unknown --mode "${opts.mode}". Use ${SEARCH_MODES.join(', ')}.`);
    return 2;
  }
  const emb = (await loadConfig(root)).search.embeddings;
  const mode = (opts.mode as SearchMode | undefined) ?? (emb.enabled ? 'hybrid' : 'keyword');
  const limit = opts.limit === undefined ? 5 : Number(opts.limit);
  const loaded = await updateIndex(root);

  let semantic: SemanticContext | undefined;
  let note: string | undefined;
  if (mode !== 'keyword') {
    try {
      const built = await buildSemantic(root, loaded, emb.model, (m) =>
        (deps.loadEmbedder ?? loadEmbedder)(m),
      );
      semantic = { ...built, weights: emb.weights };
    } catch (err) {
      // Asked for explicitly: fail. On by config: say why and fall back to keywords.
      if (opts.mode) throw err;
      note = `semantic search unavailable: ${(err as Error).message}`;
      log.warn(note);
    }
  }
  const out = await searchDetailed(loaded, query, {
    k: Number.isFinite(limit) && limit > 0 ? limit : 5,
    path: opts.path,
    includeCode: opts.code,
    semantic,
    mode: semantic ? mode : 'keyword',
  });
  if (opts.json) console.log(JSON.stringify({ stats: loaded.stats, ...out }, null, 2));
  else
    log.info(
      formatResults(out, loaded, note ? 'keyword results' : undefined).replace(
        /^(\d+\. )(\S+)/gm,
        (_, n, p) => n + c.bold(p),
      ),
    );
  return 0;
}
