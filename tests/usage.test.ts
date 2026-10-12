import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { formatUsage } from '../src/commands/usage.ts';
import { projectDirName } from '../src/core/memory.ts';
import { analyzeUsage, costOf } from '../src/core/usage.ts';
import { priceFor } from '../src/data/pricing.ts';
import { GUARD_HOOK_PATH, snapshotPlans } from '../src/generators/snapshots.ts';

import { tempProject } from './helpers.ts';

const T0 = Date.parse('2026-10-01T10:00:00Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

interface Turn {
  min: number;
  model?: string;
  read: number;
  write: number;
  input?: number;
  output?: number;
  sidechain?: boolean;
  id?: string;
}

const assistant = (sessionId: string, t: Turn, content: unknown[] = []) => ({
  type: 'assistant',
  sessionId,
  isSidechain: Boolean(t.sidechain),
  timestamp: at(t.min),
  message: {
    id: t.id ?? `msg_${t.min}_${t.read}`,
    model: t.model ?? 'claude-opus-5-5',
    content,
    usage: {
      input_tokens: t.input ?? 10,
      output_tokens: t.output ?? 100,
      cache_read_input_tokens: t.read,
      cache_creation_input_tokens: t.write,
      cache_creation: {
        ephemeral_5m_input_tokens: t.write,
        ephemeral_1h_input_tokens: 0,
      },
    },
  },
});

async function project(lines: Record<string, unknown[]>) {
  const root = await tempProject();
  const configDir = join(root, '.cfg');
  for (const [name, entries] of Object.entries(lines))
    await Bun.write(
      join(configDir, 'projects', projectDirName(root), name),
      entries.map((e) => JSON.stringify(e)).join('\n') + '\nnot json\n',
    );
  return { root, configDir };
}

describe('pricing', () => {
  test('matches ids with dates, provider prefixes and context suffixes', () => {
    expect(priceFor('claude-opus-5-5')?.input).toBe(4);
    expect(priceFor('claude-opus-5')?.input).toBe(5);
    expect(priceFor('claude-sonnet-4-5-20250929')?.input).toBe(3);
    expect(priceFor('us.anthropic.claude-haiku-4-5-20251001-v1:0')?.input).toBe(1);
    expect(priceFor('claude-opus-5-5[1m]')?.output).toBe(20);
    expect(priceFor('gpt-x')).toBeUndefined();
  });

  test('cache writes cost 1.25x input, reads the model rate', () => {
    const cost = costOf('claude-opus-5-5', {
      input: 1e6,
      output: 1e6,
      cacheRead: 1e6,
      cacheWrite5m: 1e6,
      cacheWrite1h: 1e6,
    });
    expect(cost).toBeCloseTo(4 + 20 + 0.2 + 5 + 8);
  });
});

describe('usage', () => {
  test('totals, hit ratio, cache-break causes and most-read files', async () => {
    const s = 'aaaaaaaa-1111';
    const { root, configDir } = await project({
      [`${s}.jsonl`]: [
        assistant(s, { min: 0, read: 0, write: 20_000 }, [
          {
            type: 'tool_use',
            id: 'r1',
            name: 'Read',
            input: { file_path: '/elsewhere/x.md' },
          },
        ]),
        {
          type: 'user',
          sessionId: s,
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'r1',
                content: 'x'.repeat(3500),
              },
            ],
          },
        },
        // duplicated streaming line for the same message: counted once
        assistant(s, { min: 0, read: 0, write: 20_000 }),
        assistant(s, { min: 1, read: 20_000, write: 500 }),
        assistant(s, { min: 20, read: 0, write: 21_000 }), // idle past the 5-minute TTL
        assistant(s, {
          min: 21,
          read: 0,
          write: 21_300,
          model: 'claude-sonnet-5-5',
        }), // switch
        assistant(s, {
          min: 22,
          read: 0,
          write: 21_500,
          model: 'claude-sonnet-5-5',
        }), // prefix change
        {
          type: 'system',
          subtype: 'compact_boundary',
          sessionId: s,
          timestamp: at(23),
        },
        assistant(s, {
          min: 23,
          read: 0,
          write: 5_000,
          model: 'claude-sonnet-5-5',
        }), // expected
        assistant(s, {
          min: 23,
          read: 3_000,
          write: 0,
          sidechain: true,
          model: 'claude-haiku-5-5',
        }),
      ],
    });
    const r = await analyzeUsage(root, { configDir, days: 0 });
    expect(r.sessions).toHaveLength(1);
    const session = r.sessions[0]!;
    expect(session.requests).toBe(7);
    expect(session.subagentRequests).toBe(1);
    expect(session.compactions).toBe(1);
    expect(session.breaks.map((b) => b.cause)).toEqual(['idle', 'model-switch', 'prefix-changed']);
    expect(session.breaks[0]!.idleMinutes).toBe(19);
    expect(r.breaks.every((b) => b.cost > 0)).toBe(true);
    expect(Object.keys(r.models).sort()).toEqual(['haiku-5-5', 'opus-5-5', 'sonnet-5-5']);
    expect(r.totals.tokens.cacheRead).toBe(23_000); // 20K main + 3K subagent
    expect(r.totals.hitRatio).toBeGreaterThan(0.15);
    expect(r.totals.hitRatio).toBeLessThan(0.25);
    expect(r.files).toEqual([{ path: '/elsewhere/x.md', reads: 1, tokens: 1000 }]);

    const text = formatUsage(r);
    expect(text).toContain('idle past cache TTL');
    expect(text).toContain('model switch');
    expect(text).toContain('/elsewhere/x.md');
  });

  test('session filter, day window and empty projects', async () => {
    const { root, configDir } = await project({
      'aaaa.jsonl': [assistant('aaaa', { min: 0, read: 0, write: 1000 })],
      'bbbb.jsonl': [assistant('bbbb', { min: 0, read: 0, write: 1000 })],
    });
    expect(
      (await analyzeUsage(root, { configDir, days: 0, session: 'bb' })).sessions.map((s) => s.id),
    ).toEqual(['bbbb']);
    // entries are from 2026-10-01; a 1-day window ending much later excludes them
    expect(
      (
        await analyzeUsage(root, {
          configDir,
          days: 1,
          now: T0 + 30 * 86_400_000,
        })
      ).sessions,
    ).toEqual([]);
    const empty = await analyzeUsage(await tempProject(), {
      configDir,
      days: 0,
    });
    expect(formatUsage(empty)).toContain('No Claude Code sessions');
  });
});

describe('context guard hook', () => {
  async function setup(memory = false) {
    const dir = await tempProject();
    const guard = snapshotPlans('bun', { memory }).find((p) => p.path === GUARD_HOOK_PATH)!;
    await Bun.write(join(dir, GUARD_HOOK_PATH), guard.content);
    return dir;
  }

  async function prompt(
    dir: string,
    session: string,
    used: number,
    env: Record<string, string> = {},
  ) {
    const transcript = join(dir, `${session}.jsonl`);
    await Bun.write(
      transcript,
      JSON.stringify(
        assistant(session, {
          min: 0,
          read: used,
          write: 0,
          model: 'claude-sonnet-4-6',
          output: 0,
          input: 0,
        }),
      ) + '\n',
    );
    const proc = Bun.spawn([process.execPath, join(dir, GUARD_HOOK_PATH)], {
      stdin: new TextEncoder().encode(
        JSON.stringify({ session_id: session, transcript_path: transcript }),
      ),
      stdout: 'pipe',
      env: {
        ...process.env,
        CLAUDE_KIT_CONTEXT_WINDOW: '',
        CLAUDE_KIT_COMPACT_AT: '',
        ...env,
      },
    });
    expect(await proc.exited).toBe(0);
    const out = await new Response(proc.stdout).text();
    return out ? (JSON.parse(out).hookSpecificOutput.additionalContext as string) : '';
  }

  test('warns once per level, again after the context shrinks', async () => {
    const dir = await setup();
    const session = `guard-${crypto.randomUUID()}`;
    expect(await prompt(dir, session, 50_000)).toBe('');
    expect(await prompt(dir, session, 130_000)).toContain('65%');
    expect(await prompt(dir, session, 140_000)).toBe('');
    expect(await prompt(dir, session, 170_000)).toContain('/compact');
    expect(await prompt(dir, session, 175_000)).toBe('');
    expect(await prompt(dir, session, 30_000)).toBe(''); // compacted
    expect(await prompt(dir, session, 125_000)).toContain('task_context.md');
  });

  test('CLAUDE_KIT_COMPACT_AT warns at a fixed token count', async () => {
    const dir = await setup();
    const session = `guard-${crypto.randomUUID()}`;
    const env = { CLAUDE_KIT_COMPACT_AT: '100000' };
    expect(await prompt(dir, session, 90_000, env)).toBe('');
    expect(await prompt(dir, session, 105_000, env)).toContain('~105K tokens');
  });

  test('asks for a team-memory entry every 10 prompts when memory is on', async () => {
    const withMemory = await setup(true);
    const without = await setup(false);
    const a = `guard-${crypto.randomUUID()}`;
    const b = `guard-${crypto.randomUUID()}`;
    const notes: string[] = [];
    for (let i = 1; i <= 20; i++) {
      notes.push(await prompt(withMemory, a, 10_000));
      expect(await prompt(without, b, 10_000)).toBe('');
    }
    const asked = notes.flatMap((n, i) => (n ? [i + 1] : []));
    expect(asked).toEqual([10, 20]);
    expect(notes[9]).toContain('conversation_memory.md');
  });

  test('never fails on missing or broken input', async () => {
    const dir = await setup();
    const proc = Bun.spawn([process.execPath, join(dir, GUARD_HOOK_PATH)], {
      stdin: new TextEncoder().encode('{"session_id":"x","transcript_path":"/nope.jsonl"}'),
    });
    expect(await proc.exited).toBe(0);
  });
});
