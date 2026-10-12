/**
 * `doctor --probe-mcp` (#4): start each stdio server from .mcp.json, ask it for its tools over
 * JSON-RPC, and estimate what their definitions cost per session. Running a server executes the
 * project's own configured command, which is why probing is opt-in.
 */
import { spawn } from 'node:child_process';

import { VERSION } from '../data/package.ts';
import { estimateTokens } from '../utils/tokenCount.ts';

export interface McpServerConfig {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export interface ProbedTool {
  name: string;
  tokens: number;
}

export interface ProbeResult {
  server: string;
  status: 'ok' | 'skipped' | 'failed';
  /** Why the server was skipped or failed. */
  detail?: string;
  tools: ProbedTool[];
  tokens: number;
}

const PROTOCOL_VERSION = '2025-06-18';

/** Claude Code's `${VAR}` and `${VAR:-default}` expansion in .mcp.json. */
export function expandVars(value: string, env: Record<string, string | undefined>): string {
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (_, name: string, def?: string) => env[name] ?? def ?? '',
  );
}

/** Tool-definition tokens, the way the model sees them: name, description and input schema. */
export function toolTokens(tool: {
  name?: string;
  description?: string;
  inputSchema?: unknown;
}): number {
  return estimateTokens(
    JSON.stringify({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }),
  );
}

/**
 * Tools that look like one operation split by parameter, e.g. search_by_title / search_by_author.
 * Groups names by their first two words; three or more siblings suggest one parameterised tool.
 */
export function similarTools(names: string[]): { prefix: string; tools: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const name of names) {
    const words = name.split(/[_\-.]|(?<=[a-z])(?=[A-Z])/).filter(Boolean);
    if (words.length < 3) continue;
    const prefix = words.slice(0, 2).join('_').toLowerCase();
    groups.set(prefix, [...(groups.get(prefix) ?? []), name]);
  }
  return [...groups.entries()]
    .filter(([, tools]) => tools.length >= 3)
    .map(([prefix, tools]) => ({ prefix, tools }));
}

interface RpcMessage {
  id?: number;
  result?: {
    tools?: { name?: string; description?: string; inputSchema?: unknown }[];
    nextCursor?: string;
  };
  error?: { message?: string };
}

export async function probeServer(
  name: string,
  config: McpServerConfig,
  root: string,
  timeoutMs = 15_000,
): Promise<ProbeResult> {
  const base = { server: name, tools: [] as ProbedTool[], tokens: 0 };
  if (config.url || (config.type && config.type !== 'stdio'))
    return {
      ...base,
      status: 'skipped',
      detail: `${config.type ?? 'remote'} server; only stdio servers are probed`,
    };
  if (!config.command) return { ...base, status: 'failed', detail: 'no command' };

  const env = { ...process.env, CLAUDE_PROJECT_DIR: root };
  const expand = (v: string) => expandVars(v, env);
  const child = spawn(expand(config.command), (config.args ?? []).map(expand), {
    cwd: root,
    env: {
      ...env,
      ...Object.fromEntries(Object.entries(config.env ?? {}).map(([k, v]) => [k, expand(v)])),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: process.platform === 'win32', // npx & co. are .cmd shims there
  });

  const waiting = new Map<number, (msg: RpcMessage) => void>();
  let buffer = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as RpcMessage;
        if (typeof msg.id === 'number') waiting.get(msg.id)?.(msg);
      } catch {
        // servers sometimes log to stdout; ignore non-JSON lines
      }
    }
  });
  child.stderr.on('data', (d) => (stderr = (stderr + String(d)).slice(-2000)));

  const exited = new Promise<never>((_, reject) => {
    child.on('error', (err) => reject(err));
    child.on('exit', (code) =>
      reject(
        new Error(
          `exited with code ${code}${stderr.trim() ? `: ${stderr.trim().split('\n').pop()}` : ''}`,
        ),
      ),
    );
  });
  let nextId = 1;
  const send = (method: string, params: unknown, notify = false): Promise<RpcMessage> | void => {
    if (notify) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
      return;
    }
    const id = nextId++;
    const reply = new Promise<RpcMessage>((resolve) => waiting.set(id, resolve));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return reply;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs / 1000}s`)), timeoutMs);
  });
  const call = async (method: string, params: unknown) => {
    const msg = await Promise.race([send(method, params) as Promise<RpcMessage>, exited, timeout]);
    if (msg.error) throw new Error(`${method}: ${msg.error.message ?? 'error'}`);
    return msg.result ?? {};
  };

  try {
    await call('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'claude-kit', version: VERSION },
    });
    send('notifications/initialized', {}, true);
    const tools: ProbedTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await call('tools/list', cursor ? { cursor } : {});
      for (const t of page.tools ?? []) tools.push({ name: String(t.name), tokens: toolTokens(t) });
      cursor = page.nextCursor;
    } while (cursor);
    return {
      ...base,
      status: 'ok',
      tools,
      tokens: tools.reduce((n, t) => n + t.tokens, 0),
    };
  } catch (err) {
    return { ...base, status: 'failed', detail: (err as Error).message };
  } finally {
    clearTimeout(timer);
    exited.catch(() => {});
    child.stdin.end();
    child.kill();
  }
}

export async function probeServers(
  servers: Record<string, McpServerConfig>,
  root: string,
): Promise<ProbeResult[]> {
  return Promise.all(Object.entries(servers).map(([name, cfg]) => probeServer(name, cfg, root)));
}
