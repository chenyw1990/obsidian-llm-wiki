import { Platform } from 'obsidian';
import type {
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from '../llm-sdk/acp/acp-types';

export interface QueryEngineLike {
  queryStream?(
    question: string,
    onChunk: (chunk: string) => void,
    onThinking?: (thought: string) => void,
  ): Promise<string>;
  query?(question: string): Promise<string>;
}

export interface AcpRpcContext {
  queryEngine?: QueryEngineLike | null;
  onNotification?: (notification: JsonRpcNotification) => void;
  vaultPath?: string;
}

function generateUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export async function handleAcpRpcMessage(
  request: JsonRpcRequest,
  context: AcpRpcContext,
): Promise<JsonRpcResponse> {
  const { id, method, params } = request;

  switch (method) {
    case 'initialize': {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: 1,
          agentInfo: {
            name: 'obsidian-llm-wiki',
            version: '1.27.1',
          },
          capabilities: {
            streaming: true,
          },
        },
      };
    }

    case 'session/new': {
      const sessionId = generateUuid();
      return {
        jsonrpc: '2.0',
        id,
        result: {
          sessionId,
        },
      };
    }

    case 'session/prompt': {
      const promptParams = (params ?? {}) as { sessionId?: string; prompt?: unknown };
      const sessionId = promptParams.sessionId ?? generateUuid();
      let promptText = '';

      if (typeof promptParams.prompt === 'string') {
        promptText = promptParams.prompt;
      } else if (Array.isArray(promptParams.prompt)) {
        promptText = (promptParams.prompt as Array<Record<string, unknown>>)
          .filter((p) => p && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string')
          .map((p) => String(p.text))
          .join('\n');
      }

      let answer = '';
      if (context.queryEngine) {
        if (typeof context.queryEngine.queryStream === 'function') {
          answer = await context.queryEngine.queryStream(
            promptText,
            (chunk: string) => {
              if (context.onNotification) {
                context.onNotification({
                  jsonrpc: '2.0',
                  method: 'session/update',
                  params: {
                    sessionId,
                    update: {
                      type: 'agent_message_chunk',
                      text: chunk,
                    },
                  },
                });
              }
            },
            (thought: string) => {
              if (context.onNotification) {
                context.onNotification({
                  jsonrpc: '2.0',
                  method: 'session/update',
                  params: {
                    sessionId,
                    update: {
                      type: 'agent_thought_chunk',
                      text: thought,
                    },
                  },
                });
              }
            },
          );
        } else if (typeof context.queryEngine.query === 'function') {
          answer = await context.queryEngine.query(promptText);
        }
      } else {
        answer = `Obsidian LLM Wiki received prompt: "${promptText}". (QueryEngine not attached)`;
      }

      return {
        jsonrpc: '2.0',
        id,
        result: {
          stopReason: 'end_turn',
          content: [
            {
              type: 'text',
              text: answer,
            },
          ],
        },
      };
    }

    case 'session/cancel': {
      return {
        jsonrpc: '2.0',
        id,
        result: { cancelled: true },
      };
    }

    default: {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32601,
          message: 'Method not found',
        },
      };
    }
  }
}

export interface AcpServerOptions {
  port?: number;
  queryEngine?: QueryEngineLike | null;
  vaultPath?: string;
}

export class AcpServer {
  private port: number;
  private queryEngine?: QueryEngineLike | null;
  private vaultPath?: string;
  private server: unknown = null;
  private running = false;

  constructor(options: AcpServerOptions = {}) {
    this.port = options.port ?? 8765;
    this.queryEngine = options.queryEngine;
    this.vaultPath = options.vaultPath;
  }

  setQueryEngine(engine: QueryEngineLike | null): void {
    this.queryEngine = engine;
  }

  async start(port?: number): Promise<number> {
    if (!Platform.isDesktop) {
      throw new Error('ACP server is only supported on Obsidian desktop');
    }

    if (this.running) {
      return this.port;
    }

    const activePort = port ?? this.port;
    const nodeModule = await import('node:module');
    // eslint-disable-next-line no-undef -- __filename is a CJS global injected by esbuild's CJS bundler; not a browser global - desktop-only, guarded by Platform.isDesktop above
    const nodeRequire = nodeModule.Module.createRequire(__filename);
    const http = nodeRequire('node:http') as typeof import('node:http');

    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        void (async () => {
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

          if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
          }

          if (req.method !== 'POST') {
            res.writeHead(405, { 'Content-Type': 'text/plain' });
            res.end('Method Not Allowed');
            return;
          }

          let body = '';
          req.on('data', (chunk: unknown) => {
            body += String(chunk);
          });

          req.on('end', () => {
            void (async () => {
              try {
                const parsed = JSON.parse(body) as JsonRpcRequest;
                res.writeHead(200, {
                  'Content-Type': 'application/x-ndjson',
                  'Transfer-Encoding': 'chunked',
                });

                const onNotification = (notification: JsonRpcNotification) => {
                  res.write(JSON.stringify(notification) + '\n');
                };

                const response = await handleAcpRpcMessage(parsed, {
                  queryEngine: this.queryEngine,
                  onNotification,
                  vaultPath: this.vaultPath,
                });

                res.write(JSON.stringify(response) + '\n');
                res.end();
              } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(
                  JSON.stringify({
                    jsonrpc: '2.0',
                    id: null,
                    error: {
                      code: -32700,
                      message: 'Parse error',
                      data: String(err),
                    },
                  }),
                );
              }
            })();
          });
        })();
      });

      server.on('error', (err) => {
        reject(err);
      });

      server.listen(activePort, '127.0.0.1', () => {
        this.running = true;
        this.server = server;
        this.port = activePort;
        resolve(activePort);
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.running || !this.server) {
      return;
    }

    const server = this.server as { close: (cb: () => void) => void };
    return new Promise((resolve) => {
      server.close(() => {
        this.running = false;
        this.server = null;
        resolve();
      });
    });
  }

  isRunning(): boolean {
    return this.running;
  }

  getPort(): number {
    return this.port;
  }
}
