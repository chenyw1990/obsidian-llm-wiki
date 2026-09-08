import { Platform } from 'obsidian';
import { requireDesktopNodeModule } from './desktop-node-require';
import type {
  JsonRpcError,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from './acp-types';

export type NotificationHandler = (notification: JsonRpcNotification) => void;

export interface AcpConnection {
  sendRequest<TResult = unknown, TParams = unknown>(
    method: string,
    params?: TParams,
    signal?: AbortSignal,
  ): Promise<TResult>;
  onNotification(handler: NotificationHandler): () => void;
  close(): Promise<void>;
  isConnected(): boolean;
}

export interface AcpHttpConnectionOptions {
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
}

export interface AcpWebSocketConnectionOptions {
  url: string;
  apiKey?: string;
  protocols?: string | string[];
}

export interface AcpStdioConnectionOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export class AcpHttpConnection implements AcpConnection {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly headers: Record<string, string>;
  private readonly notificationHandlers = new Set<NotificationHandler>();
  private nextId = 1;
  private connected = true;

  constructor(options: AcpHttpConnectionOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey?.trim() || undefined;
    const win = typeof activeWindow !== 'undefined' ? activeWindow : (typeof window !== 'undefined' ? window : undefined);
    const resolvedFetch = options.fetchImpl ?? (win && typeof win.fetch === 'function' ? win.fetch.bind(win) : undefined);
    if (!resolvedFetch) {
      throw new TypeError('AcpHttpConnection: fetch is not available in this environment');
    }
    this.fetchImpl = resolvedFetch;
    this.headers = options.headers ?? {};
  }

  async sendRequest<TResult = unknown, TParams = unknown>(
    method: string,
    params?: TParams,
    signal?: AbortSignal,
  ): Promise<TResult> {
    const id = this.nextId++;
    const payload: JsonRpcRequest<TParams> = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, application/x-ndjson, text/event-stream',
      ...this.headers,
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    const response = await this.fetchImpl(this.baseUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status} ${response.statusText}: ${errorText}`);
    }

    const contentType = response.headers.get('content-type')?.toLowerCase() || '';

    // If streaming response (NDJSON or SSE or chunked)
    if (contentType.includes('application/x-ndjson') || contentType.includes('text/event-stream')) {
      return this.handleStreamResponse<TResult>(response, id);
    }

    const text = await response.text();
    // Some ACP servers may stream multiple JSON objects delimited by newlines even with application/json
    if (text.includes('\n')) {
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
      let finalResult: TResult | undefined;
      let hasResult = false;
      let rpcError: JsonRpcError | undefined;

      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as JsonRpcResponse<TResult> | JsonRpcNotification;
          if ('id' in parsed && parsed.id === id) {
            if (parsed.error) {
              rpcError = parsed.error;
            } else {
              finalResult = parsed.result;
              hasResult = true;
            }
          } else if ('method' in parsed && !('id' in parsed)) {
            this.dispatchNotification(parsed);
          }
        } catch {
          // Ignore partial or non-JSON line
        }
      }
      if (rpcError) {
        throw new Error(rpcError.message || `JSON-RPC error code ${rpcError.code}`);
      }
      if (hasResult) {
        return finalResult as TResult;
      }
    }

    let parsed: JsonRpcResponse<TResult>;
    try {
      parsed = JSON.parse(text) as JsonRpcResponse<TResult>;
    } catch {
      throw new Error(`Invalid JSON response from ACP server: ${text.slice(0, 100)}`);
    }

    if (parsed.error) {
      throw new Error(parsed.error.message || `JSON-RPC error code ${parsed.error.code}`);
    }

    return parsed.result as TResult;
  }

  private async handleStreamResponse<TResult>(response: Response, targetId: number | string): Promise<TResult> {
    if (!response.body) {
      throw new Error('Response body is null on streaming endpoint');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalResult: TResult | undefined;
    let hasResult = false;
    let rpcError: JsonRpcError | undefined;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);

          if (!line) continue;
          // Handle SSE data: lines
          const jsonStr = line.startsWith('data:') ? line.slice(5).trim() : line;
          if (!jsonStr || jsonStr === '[DONE]') continue;

          try {
            const msg = JSON.parse(jsonStr) as JsonRpcResponse<TResult> | JsonRpcNotification;
            if ('id' in msg && msg.id === targetId) {
              if (msg.error) {
                rpcError = msg.error;
              } else {
                finalResult = msg.result;
                hasResult = true;
              }
            } else if ('method' in msg && !('id' in msg)) {
              this.dispatchNotification(msg);
            }
          } catch {
            // Partial chunk
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (rpcError) {
      throw new Error(rpcError.message || `JSON-RPC error code ${rpcError.code}`);
    }
    if (!hasResult && buffer.trim()) {
      try {
        const msg = JSON.parse(buffer.trim()) as JsonRpcResponse<TResult>;
        if (msg.id === targetId) {
          if (msg.error) throw new Error(msg.error.message);
          return msg.result as TResult;
        }
      } catch {
        // ignore
      }
    }

    return finalResult as TResult;
  }

  private dispatchNotification(notification: JsonRpcNotification): void {
    for (const handler of this.notificationHandlers) {
      try {
        handler(notification);
      } catch {
        // Suppress individual handler failures
      }
    }
  }

  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  async close(): Promise<void> {
    this.connected = false;
    this.notificationHandlers.clear();
  }

  isConnected(): boolean {
    return this.connected;
  }
}

export class AcpWebSocketConnection implements AcpConnection {
  private ws: WebSocket | null = null;
  private readonly url: string;
  private readonly protocols?: string | string[];
  private readonly pending = new Map<
    string | number,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void }
  >();
  private readonly notificationHandlers = new Set<NotificationHandler>();
  private nextId = 1;
  private connected = false;

  constructor(options: AcpWebSocketConnectionOptions) {
    this.url = options.url;
    this.protocols = options.protocols;
  }

  async connect(): Promise<void> {
    await this.ensureConnected();
  }

  private async ensureConnected(): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return this.ws;
    }

    return new Promise((resolve, reject) => {
      try {
        const socket = new WebSocket(this.url, this.protocols);
        this.ws = socket;

        socket.onopen = () => {
          this.connected = true;
          resolve(socket);
        };

        socket.onmessage = (event) => {
          this.handleMessage(String(event.data));
        };

        socket.onerror = () => {
          if (!this.connected) {
            reject(new Error(`WebSocket connection failed to ${this.url}`));
          }
        };

        socket.onclose = () => {
          this.connected = false;
          for (const { reject: pendingReject } of this.pending.values()) {
            pendingReject(new Error('WebSocket connection closed'));
          }
          this.pending.clear();
        };
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private handleMessage(raw: string): void {
    try {
      const parsed = JSON.parse(raw) as JsonRpcResponse | JsonRpcNotification;
      if ('id' in parsed && parsed.id !== undefined && parsed.id !== null) {
        const pendingPromise = this.pending.get(parsed.id);
        if (pendingPromise) {
          this.pending.delete(parsed.id);
          if (parsed.error) {
            pendingPromise.reject(
              new Error(parsed.error.message || `JSON-RPC error code ${parsed.error.code}`),
            );
          } else {
            pendingPromise.resolve(parsed.result);
          }
        }
      } else if ('method' in parsed) {
        this.dispatchNotification(parsed);
      }
    } catch {
      // Ignore unparseable frames
    }
  }

  private dispatchNotification(notification: JsonRpcNotification): void {
    for (const handler of this.notificationHandlers) {
      try {
        handler(notification);
      } catch {
        // Ignore handler error
      }
    }
  }

  async sendRequest<TResult = unknown, TParams = unknown>(
    method: string,
    params?: TParams,
    signal?: AbortSignal,
  ): Promise<TResult> {
    const socket = await this.ensureConnected();
    const id = this.nextId++;
    const payload: JsonRpcRequest<TParams> = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };

    return new Promise<TResult>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('Request aborted'));
        return;
      }

      const onAbort = () => {
        this.pending.delete(id);
        reject(new Error('Request aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      this.pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(value as TResult);
        },
        reject: (reason: Error) => {
          signal?.removeEventListener('abort', onAbort);
          reject(reason);
        },
      });

      socket.send(JSON.stringify(payload));
    });
  }

  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  async close(): Promise<void> {
    this.connected = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.notificationHandlers.clear();
  }

  isConnected(): boolean {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }
}

export function buildEnrichedPath(currentPath?: string): string {
  const commonDirs = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];
  const userHome =
    typeof window !== 'undefined' && 'process' in window
      ? (window as unknown as { process: { env: Record<string, string | undefined> } }).process.env.HOME
      : undefined;

  const homeDirs = userHome
    ? [
        `${userHome}/.local/bin`,
        `${userHome}/.gemini/antigravity/bin`,
        `${userHome}/.antigravity/antigravity/bin`,
        `${userHome}/.cargo/bin`,
        `${userHome}/.nvm/current/bin`,
      ]
    : [];

  const existingParts = currentPath ? currentPath.split(':').filter(Boolean) : [];
  const combined = [...existingParts];
  for (const dir of [...homeDirs, ...commonDirs]) {
    if (!combined.includes(dir)) {
      combined.push(dir);
    }
  }
  return combined.join(':');
}

export class AcpStdioConnection implements AcpConnection {
  private readonly options: AcpStdioConnectionOptions;
  private readonly notificationHandlers = new Set<NotificationHandler>();
  private readonly pending = new Map<
    string | number,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void }
  >();
  private childProcess: unknown = null;
  private nextId = 1;
  private connected = false;

  constructor(options: AcpStdioConnectionOptions) {
    if (!Platform.isDesktop) {
      throw new Error('ACP stdio transport is only supported on Obsidian desktop');
    }
    this.options = options;
  }

  private async ensureSpawned(): Promise<unknown> {
    if (!Platform.isDesktop) {
      throw new Error('ACP stdio transport is only supported on Obsidian desktop');
    }
    if (this.childProcess) return this.childProcess;

    const procEnv: Record<string, string | undefined> =
      typeof window !== 'undefined' && 'process' in window
        ? (window as unknown as { process: { env: Record<string, string | undefined> } }).process.env
        : {};

    const enrichedPath = buildEnrichedPath(procEnv.PATH);
    const env = { ...procEnv, PATH: enrichedPath, ...this.options.env };

    const { spawn } = requireDesktopNodeModule<typeof import('node:child_process')>('node:child_process');
    const child = spawn(this.options.command, this.options.args ?? [], {
      cwd: this.options.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
    });

    let buffer = '';
    child.stdout.on('data', (chunk: unknown) => {
      buffer += String(chunk);
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as JsonRpcResponse | JsonRpcNotification;
          if ('id' in parsed && parsed.id !== undefined && parsed.id !== null) {
            const pending = this.pending.get(parsed.id);
            if (pending) {
              this.pending.delete(parsed.id);
              if (parsed.error) {
                pending.reject(new Error(parsed.error.message || `Code ${parsed.error.code}`));
              } else {
                pending.resolve(parsed.result);
              }
            }
          } else if ('method' in parsed) {
            for (const handler of this.notificationHandlers) {
              handler(parsed);
            }
          }
        } catch {
          // ignore unparseable lines
        }
      }
    });

    let stderrOutput = '';
    child.stderr?.on('data', (chunk: unknown) => {
      stderrOutput += String(chunk);
      if (stderrOutput.length > 2000) {
        stderrOutput = stderrOutput.slice(-2000);
      }
    });

    child.on('error', (err: Error) => {
      this.connected = false;
      this.childProcess = null;
      for (const { reject } of this.pending.values()) {
        reject(new Error(`Failed to start ACP process: ${err.message}`));
      }
      this.pending.clear();
    });

    child.on('exit', (code: number | null) => {
      this.connected = false;
      this.childProcess = null;
      const detail = stderrOutput.trim() ? `: ${stderrOutput.trim()}` : '';
      for (const { reject } of this.pending.values()) {
        reject(new Error(`ACP process exited with code ${code ?? 0}${detail}`));
      }
      this.pending.clear();
    });

    this.childProcess = child;
    this.connected = true;
    return child;
  }

  async sendRequest<TResult = unknown, TParams = unknown>(
    method: string,
    params?: TParams,
    signal?: AbortSignal,
  ): Promise<TResult> {
    const child = (await this.ensureSpawned()) as { stdin: { write: (data: string) => void } };
    const id = this.nextId++;
    const payload: JsonRpcRequest<TParams> = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };

    return new Promise<TResult>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('Request aborted'));
        return;
      }

      this.pending.set(id, {
        resolve: (value) => resolve(value as TResult),
        reject,
      });

      child.stdin.write(JSON.stringify(payload) + '\n');
    });
  }

  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  async close(): Promise<void> {
    this.connected = false;
    if (this.childProcess) {
      const child = this.childProcess as { kill: () => void };
      child.kill();
      this.childProcess = null;
    }
    this.notificationHandlers.clear();
  }

  isConnected(): boolean {
    return this.connected;
  }
}
