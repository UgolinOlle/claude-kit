/**
 * Minimal MCP server over stdio (newline-delimited JSON-RPC), enough for tools: initialize,
 * ping, tools/list, tools/call. Kept in-house so the package stays dependency-free; stdout
 * carries protocol messages only, so nothing else may write to it while serving.
 */
import { createInterface } from 'node:readline';

export interface McpTool {
  name: string;
  description: string;
  /** JSON Schema of the arguments object. */
  inputSchema: Record<string, unknown>;
  handler(args: Record<string, unknown>): Promise<string> | string;
}

interface Request {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];

export class ToolError extends Error {}

export async function handleMessage(
  msg: Request,
  info: { name: string; version: string; instructions?: string },
  tools: McpTool[],
): Promise<Record<string, unknown> | null> {
  if (msg.id === undefined || msg.id === null) return null; // notification
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code: number, message: string) => ({
    jsonrpc: '2.0',
    id: msg.id,
    error: { code, message },
  });

  switch (msg.method) {
    case 'initialize': {
      const asked = String(msg.params?.protocolVersion ?? '');
      return reply({
        protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
        capabilities: { tools: {} },
        serverInfo: { name: info.name, version: info.version },
        ...(info.instructions ? { instructions: info.instructions } : {}),
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({
        tools: tools.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      });
    case 'tools/call': {
      const tool = tools.find((t) => t.name === msg.params?.name);
      if (!tool) return fail(-32602, `Unknown tool: ${String(msg.params?.name)}`);
      try {
        const text = await tool.handler((msg.params?.arguments ?? {}) as Record<string, unknown>);
        return reply({ content: [{ type: 'text', text }] });
      } catch (err) {
        // Tool errors go back to the model as results it can act on, not protocol errors.
        return reply({ content: [{ type: 'text', text: (err as Error).message }], isError: true });
      }
    }
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

export async function serveStdio(
  info: { name: string; version: string; instructions?: string },
  tools: McpTool[],
  io: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream } = {},
): Promise<void> {
  const output = io.output ?? process.stdout;
  const lines = createInterface({ input: io.input ?? process.stdin, crlfDelay: Infinity });
  // Calls are answered in arrival order; a slow call delays the next, which MCP allows.
  for await (const line of lines) {
    if (!line.trim()) continue;
    let msg: Request;
    try {
      msg = JSON.parse(line) as Request;
    } catch {
      output.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        }) + '\n',
      );
      continue;
    }
    const res = await handleMessage(msg, info, tools);
    if (res) output.write(JSON.stringify(res) + '\n');
  }
}
