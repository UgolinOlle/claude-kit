import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { GlobalOptions } from '../src/cli.ts';
import { runInit } from '../src/commands/init.ts';
import { runSearch, searchTools } from '../src/commands/search.ts';
import { loadConfig } from '../src/core/config.ts';
import { handleMessage } from '../src/mcp/stdioServer.ts';
import { buildRuleContext } from '../src/rules/context.ts';
import { runRules } from '../src/rules/index.ts';
import { DEFAULT_MODEL, type Embedder, loadEmbedder, SetupError } from '../src/search/embed.ts';
import { INDEX_DIR, updateIndex } from '../src/search/index.ts';
import { search, searchDetailed } from '../src/search/query.ts';
import {
  coverage,
  emptyStore,
  loadStore,
  saveStore,
  SemanticIndex,
  updateVectors,
} from '../src/search/semantic.ts';
import { configureLogger } from '../src/utils/logger.ts';

import { tempProject } from './helpers.ts';

/** Words the fake model treats as the same meaning. */
const SYNONYMS: Record<string, string> = {
  candidature: 'application',
  candidatures: 'application',
  applications: 'application',
  twice: 'again',
  duplicate: 'again',
};

/**
 * Deterministic stand-in for a real model: a hashed bag of words (synonyms folded together),
 * unit length. Records every text it embeds.
 */
function fakeEmbedder(opts: { model?: string; calls?: string[]; minSimilarity?: number } = {}) {
  const dims = 64;
  const vector = (text: string) => {
    const v = new Float32Array(dims);
    for (const raw of text.toLowerCase().match(/[a-z]+/g) ?? []) {
      const w = SYNONYMS[raw] ?? raw;
      let h = 0;
      for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      v[h % dims]! += 1;
    }
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  };
  const embedder: Embedder = {
    model: opts.model ?? DEFAULT_MODEL,
    dims,
    minSimilarity: opts.minSimilarity,
    async embed(texts, kind) {
      if (kind === 'passage') opts.calls?.push(...texts);
      return texts.map(vector);
    },
  };
  return embedder;
}

async function project(files: Record<string, string>) {
  const dir = await tempProject();
  for (const [path, body] of Object.entries(files)) await Bun.write(join(dir, path), body);
  return dir;
}

const APP = {
  'src/applications.ts': [
    'export function claimApplication(userId: string, jobId: string) {',
    '  // one application row per (user, job): it is never sent again',
    '  return db.insert({ userId, jobId });',
    '}',
  ].join('\n'),
  'src/messaging.ts': [
    'export function sendMessage(text: string) {',
    '  // prevent sending the same message twice when the network retries',
    '  return queue.push(text);',
    '}',
  ].join('\n'),
  'src/apply.ts': [
    'export function submitCandidature(application: Application) {',
    '  // prevent sending a candidature twice: the application is claimed first',
    '  return claimApplication(application.userId, application.jobId);',
    '}',
  ].join('\n'),
  'src/billing.ts': 'export function totalInvoice(lines: number[]) {\n  return 0;\n}\n',
};

const opts = (cwd: string, extra: Partial<GlobalOptions> = {}): GlobalOptions => ({
  cwd,
  dryRun: false,
  yes: false,
  force: false,
  json: false,
  verbose: false,
  with: [],
  without: [],
  ...extra,
});

const enable = (dir: string, extra: Record<string, unknown> = {}) =>
  Bun.write(
    join(dir, '.claude-kit/config.json'),
    JSON.stringify({ search: { embeddings: { enabled: true, ...extra } } }),
  );

// Nothing in these tests may touch the real per-user cache.
let cache: string;
const savedCache = process.env.CLAUDE_KIT_CACHE_DIR;
beforeAll(async () => {
  configureLogger({ silent: true });
  cache = await mkdtemp(join(tmpdir(), 'claude-kit-cache-'));
  process.env.CLAUDE_KIT_CACHE_DIR = cache;
});
afterAll(async () => {
  if (savedCache === undefined) delete process.env.CLAUDE_KIT_CACHE_DIR;
  else process.env.CLAUDE_KIT_CACHE_DIR = savedCache;
  await rm(cache, { recursive: true, force: true });
});

async function built(dir: string, embedder = fakeEmbedder()) {
  const loaded = await updateIndex(dir);
  const store = await updateVectors(loaded, embedder, emptyStore(embedder.model, embedder.dims));
  return { loaded, semantic: { embedder, store } };
}

describe('hybrid ranking (reciprocal rank fusion)', () => {
  test('a file found only by meaning comes up; one found both ways ranks first', async () => {
    const dir = await project(APP);
    const { loaded, semantic } = await built(dir);
    const query = 'prevent sending a candidature twice';

    const keyword = (await search(loaded, query, { k: 10 })).map((r) => r.path);
    expect(keyword).not.toContain('src/applications.ts'); // no shared word

    const meaning = (await search(loaded, query, { k: 10, mode: 'semantic', semantic })).map(
      (r) => r.path,
    );
    expect(meaning.slice(0, 3)).toContain('src/applications.ts');

    const hybrid = await search(loaded, query, { k: 3, semantic }); // hybrid by default
    expect(hybrid[0]!.path).toBe('src/apply.ts'); // top by keywords and by meaning
    expect(hybrid.map((r) => r.path)).toContain('src/applications.ts');
    expect(hybrid.map((r) => r.path)).not.toContain('src/billing.ts');
  });

  test('weights tilt the fusion; modes need embeddings', async () => {
    const dir = await project(APP);
    const { loaded, semantic } = await built(dir);
    const query = 'prevent sending a candidature twice';
    const kwOnly = await search(loaded, query, {
      k: 4,
      semantic: { ...semantic, weights: { keyword: 1, semantic: 0 } },
    });
    expect(kwOnly.map((r) => r.path)).not.toContain('src/applications.ts');
    expect(search(loaded, query, { mode: 'hybrid' })).rejects.toThrow('needs embeddings');
  });

  test('says "no relevant match" below the model threshold, unless every word matches', async () => {
    const dir = await project(APP);
    const { loaded, semantic } = await built(dir, fakeEmbedder({ minSimilarity: 0.5 }));
    const none = await searchDetailed(loaded, 'kubernetes helm ingress', { semantic });
    expect(none.noRelevantMatch).toBe(true);
    expect(none.results).toEqual([]);
    // the same rare words written in a file: exact keyword coverage wins
    await Bun.write(join(dir, 'deploy/notes.md'), '# Ops\n\nkubernetes helm ingress, someday\n');
    const again = await built(dir, fakeEmbedder({ minSimilarity: 0.99 }));
    const found = await searchDetailed(again.loaded, 'kubernetes helm ingress', {
      semantic: again.semantic,
    });
    expect(found.noRelevantMatch).toBe(false);
    expect(found.results[0]!.path).toBe('deploy/notes.md');
  });
});

describe('semantic index: incremental updates and storage', () => {
  test('only changed chunks are embedded; deleted files lose their vectors', async () => {
    const dir = await project({
      ...APP,
      'src/two.ts':
        'export function first() {\n  return 1;\n}\n\nexport function second() {\n  return 2;\n}\n',
    });
    const calls: string[] = [];
    const embedder = fakeEmbedder({ calls });
    let loaded = await updateIndex(dir);
    let store = await updateVectors(loaded, embedder, emptyStore(embedder.model, embedder.dims));
    expect(calls.length).toBe(loaded.stats.chunks);
    expect(coverage(loaded, store)).toEqual({
      done: loaded.stats.chunks,
      total: loaded.stats.chunks,
    });

    // nothing changed: nothing embedded
    calls.length = 0;
    store = await updateVectors(await updateIndex(dir), embedder, store);
    expect(calls).toEqual([]);

    // one function edited: only its chunk
    await Bun.write(
      join(dir, 'src/two.ts'),
      'export function first() {\n  return 1;\n}\n\nexport function second() {\n  return 22;\n}\n',
    );
    loaded = await updateIndex(dir);
    store = await updateVectors(loaded, embedder, store);
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain('return 22');

    // a deleted file takes its vectors with it
    const before = store.vectors.size;
    await rm(join(dir, 'src/billing.ts'));
    loaded = await updateIndex(dir);
    store = await updateVectors(loaded, embedder, store);
    expect(store.files['src/billing.ts']).toBeUndefined();
    expect(store.vectors.size).toBe(before - 1);

    // the saved store matches, and another model starts over
    const saved = await loadStore(dir, embedder.model, embedder.dims);
    expect(saved.vectors.size).toBe(store.vectors.size);
    calls.length = 0;
    const other = fakeEmbedder({ model: 'Xenova/all-MiniLM-L6-v2', calls });
    await updateVectors(loaded, other, saved);
    expect(calls.length).toBe(loaded.stats.chunks);
    expect((await loadStore(dir, embedder.model, embedder.dims)).vectors.size).toBe(0);
  });

  test('embeddings.bin / embeddings.json round trip; a mismatched pair is discarded', async () => {
    const dir = await tempProject();
    const store = emptyStore('m', 4);
    store.vectors.set('a', Float32Array.from([1, 0, 0, 0]));
    store.vectors.set('b', Float32Array.from([0, 0.5, 0.5, 0]));
    store.vectors.set('orphan', Float32Array.from([0, 0, 0, 1]));
    store.files = { 'x.ts': { size: 1, mtimeMs: 2, keys: ['a', 'b'] } };
    await saveStore(dir, store);
    const back = await loadStore(dir, 'm', 4);
    expect([...back.vectors.keys()]).toEqual(['a', 'b']); // orphan dropped
    expect([...back.vectors.get('b')!]).toEqual([0, 0.5, 0.5, 0]);
    expect(back.files).toEqual(store.files);
    expect((await loadStore(dir, 'other', 4)).vectors.size).toBe(0);
    expect(await Bun.file(join(dir, INDEX_DIR, '.gitignore')).text()).toBe('*\n');

    // a bin from another write (different stamp) doesn't pass for this json
    const json = await Bun.file(join(dir, INDEX_DIR, 'embeddings.json')).text();
    await saveStore(dir, store);
    await Bun.write(join(dir, INDEX_DIR, 'embeddings.json'), json);
    expect((await loadStore(dir, 'm', 4)).vectors.size).toBe(0);
  });

  test('one build at a time; later requests join it', async () => {
    const dir = await project(APP);
    let loads = 0;
    const calls: string[] = [];
    const index = new SemanticIndex(dir, DEFAULT_MODEL, async () => {
      loads++;
      return fakeEmbedder({ calls });
    });
    const loaded = await updateIndex(dir);
    const [a, b] = await Promise.all([index.refresh(loaded), index.refresh(loaded)]);
    expect(a.store).toBe(b.store);
    expect(loads).toBe(1);
    expect(calls.length).toBe(loaded.stats.chunks);
    expect(index.state).toMatchObject({ ready: true, done: loaded.stats.chunks });
  });
});

describe('code-search MCP server with embeddings', () => {
  const call = (dir: string, deps: Parameters<typeof searchTools>[1], query: string) =>
    handleMessage(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'search_code', arguments: { query } },
      },
      { name: 't', version: '0' },
      searchTools(dir, deps),
    );
  const text = (res: Record<string, unknown> | null) =>
    (res!.result as { content: { text: string }[] }).content[0]!.text;

  test('answers with keywords and progress while the index builds, never waits long', async () => {
    const dir = await project(APP);
    await enable(dir);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: Embedder = {
      ...fakeEmbedder(),
      async embed(texts, kind) {
        await gate; // a model that's still busy
        return fakeEmbedder().embed(texts, kind);
      },
    };
    const tools = searchTools(dir, { loadEmbedder: async () => slow, waitMs: 50 });
    const callWith = async (query: string) =>
      text(
        await handleMessage(
          {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'search_code', arguments: { query } },
          },
          { name: 't', version: '0' },
          tools,
        ),
      );
    const t0 = performance.now();
    const first = await callWith('prevent sending a candidature twice');
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(first).toContain('semantic index: 0% built, keyword results');
    expect(first).not.toContain('src/applications.ts');

    release();
    await Bun.sleep(20);
    const later = await callWith('prevent sending a candidature twice');
    expect(later).not.toContain('semantic index');
    expect(later).toContain('src/applications.ts'); // found by meaning now
  });

  test('a long build is not waited for: the answer comes at once', async () => {
    const files: Record<string, string> = { ...APP };
    for (let i = 0; i < 80; i++) files[`src/gen/f${i}.ts`] = `export const value${i} = ${i};\n`;
    const dir = await project(files);
    await enable(dir);
    const stuck: Embedder = { ...fakeEmbedder(), embed: () => new Promise(() => {}) };
    const tools = searchTools(dir, { loadEmbedder: async () => stuck, waitMs: 1500 });
    const ask = () =>
      handleMessage(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'search_code', arguments: { query: 'claim application' } },
        },
        { name: 't', version: '0' },
        tools,
      );
    await ask(); // starts the build (waits: no progress known yet)
    const t0 = performance.now();
    expect(text(await ask())).toContain('semantic index: 0% built');
    expect(performance.now() - t0).toBeLessThan(1000);
  }, 15_000);

  test('a missing runtime is reported in the footer, keyword results still come back', async () => {
    const dir = await project(APP);
    await enable(dir);
    const out = text(
      await call(
        dir,
        {
          loadEmbedder: async () => {
            throw new SetupError(
              "The embeddings runtime isn't installed: run `claude-kit search --setup`.",
            );
          },
          waitMs: 50,
        },
        'refresh session claim application',
      ),
    );
    expect(out).toContain('src/applications.ts');
    expect(out).toContain('semantic search unavailable');
    expect(out).toContain('--setup');
  });

  test('disabled by default: nothing is loaded', async () => {
    const dir = await project(APP);
    let loads = 0;
    const out = text(
      await call(dir, { loadEmbedder: async () => (loads++, fakeEmbedder()) }, 'claim application'),
    );
    expect(loads).toBe(0);
    expect(out).toContain('src/applications.ts');
    expect(out).not.toContain('semantic');
  });
});

describe('config', () => {
  const load = async (embeddings: unknown) => {
    const dir = await tempProject();
    await Bun.write(
      join(dir, '.claude-kit/config.json'),
      JSON.stringify({ search: { embeddings } }),
    );
    return loadConfig(dir);
  };

  test('defaults and valid values', async () => {
    expect((await loadConfig(await tempProject())).search.embeddings).toEqual({
      enabled: false,
      model: 'Xenova/multilingual-e5-small',
      weights: { keyword: 1, semantic: 1 },
    });
    expect(
      (
        await load({
          enabled: true,
          model: 'Xenova/all-MiniLM-L6-v2',
          weights: { semantic: 2 },
        })
      ).search.embeddings,
    ).toEqual({
      enabled: true,
      model: 'Xenova/all-MiniLM-L6-v2',
      weights: { keyword: 1, semantic: 2 },
    });
  });

  test.each([
    [{ enabled: 'yes' }, 'enabled must be true or false'],
    [{ model: 'openai/text-embedding-3' }, 'unknown model "openai/text-embedding-3"'],
    [{ weights: { keyword: -1 } }, 'weights.keyword must be a number ≥ 0'],
    [{ weights: { keyword: 0, semantic: 0 } }, 'at least one weight'],
    [{ weights: { bm25: 1 } }, 'unknown weight "bm25"'],
    [{ enable: true }, 'unknown key "enable"'],
    [true, 'must be an object'],
  ])('rejects %j', async (value, message) => {
    expect(load(value)).rejects.toThrow(message);
  });
});

describe('search --setup consent and doctor', () => {
  const missing = async () => ({ runtime: false, model: false });

  test('without a terminal and without --yes: refused, nothing downloaded', async () => {
    const dir = await project(APP);
    const done: string[] = [];
    const deps = {
      installed: missing,
      confirm: null,
      install: async () => void done.push('install'),
      loadEmbedder: async () => (done.push('model'), fakeEmbedder()),
    };
    expect(await runSearch(opts(dir, { setup: true }), [], deps)).toBe(2);
    expect(done).toEqual([]);

    const questions: string[] = [];
    const declined = { ...deps, confirm: async (q: string) => (questions.push(q), false) };
    expect(await runSearch(opts(dir, { setup: true }), [], declined)).toBe(1);
    expect(done).toEqual([]);
    expect(questions[0]).toContain('@huggingface/transformers@');
    expect(questions[0]).toMatch(/multilingual-e5-small model from huggingface\.co \(~\d+ MB\)/);
    expect(questions[0]).toContain(cache);
  });

  test('--yes installs, downloads and indexes the project', async () => {
    const dir = await project(APP);
    const done: string[] = [];
    const code = await runSearch(opts(dir, { setup: true, yes: true }), [], {
      installed: missing,
      install: async () => void done.push('install'),
      loadEmbedder: async (_m, o) => (
        done.push(`model download=${o?.allowDownload}`),
        fakeEmbedder()
      ),
    });
    expect(code).toBe(0);
    expect(done).toEqual(['install', 'model download=true']);
    const loaded = await updateIndex(dir);
    const store = await loadStore(dir, DEFAULT_MODEL, 64);
    expect(coverage(loaded, store).done).toBe(loaded.stats.chunks);
    expect(await Bun.file(join(dir, 'package.json')).exists()).toBe(false);
  });

  test('loading never downloads: a missing model is a setup error', async () => {
    expect(loadEmbedder(DEFAULT_MODEL)).rejects.toThrow('search --setup');
  });

  test('doctor: enabled without runtime or without the search feature', async () => {
    const dir = await tempProject('bun-app');
    await runInit(opts(dir, { yes: true }), { hookRuntime: 'node', interactive: false });
    await enable(dir);
    const audit = async () =>
      (
        await runRules(
          await buildRuleContext(dir, {
            hookRuntime: 'node',
            memory: { configDir: join(dir, '.fake-config') },
          }),
        )
      ).findings.filter((f) => f.ruleId === 'search/embeddings');
    const findings = await audit();
    expect(findings.map((f) => f.message).join('\n')).toContain(
      "code-search MCP server isn't set up",
    );
    expect(findings.map((f) => f.hint).join('\n')).toContain('search --setup');
    expect(findings.every((f) => f.severity === 'info')).toBe(true);
  });
});

// Real model, real download: CLAUDE_KIT_TEST_EMBEDDINGS=1 bun test tests/search-embeddings.test.ts
// (uses CLAUDE_KIT_REAL_CACHE_DIR, or ~/.cache/claude-kit, where --setup installed the runtime).
describe.skipIf(process.env.CLAUDE_KIT_TEST_EMBEDDINGS !== '1')('real embeddings model', () => {
  test('a synonym query finds the right file', async () => {
    const realCache = process.env.CLAUDE_KIT_REAL_CACHE_DIR ?? savedCache;
    if (realCache) process.env.CLAUDE_KIT_CACHE_DIR = realCache;
    else delete process.env.CLAUDE_KIT_CACHE_DIR;
    try {
      const dir = await project({
        ...APP,
        'src/apply.ts': 'export const nothing = 1;\n',
      });
      const embedder = await loadEmbedder(DEFAULT_MODEL);
      const { loaded, semantic } = await built(dir, embedder);
      const results = await search(loaded, 'stop a job application from being submitted twice', {
        k: 2,
        semantic,
      });
      expect(results[0]!.path).toBe('src/applications.ts');
    } finally {
      process.env.CLAUDE_KIT_CACHE_DIR = cache;
    }
  }, 120_000);
});
