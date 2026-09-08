import { Platform } from 'obsidian';
import type {
  AcpConnection,
  NotificationHandler,
} from './acp-connection';
import { buildEnrichedPath } from './acp-connection';
import { requireDesktopNodeModule } from './desktop-node-require';
import type {
  AcpInitializeResult,
  AcpPromptResult,
  JsonRpcNotification,
} from './acp-types';

export interface AcpCodexCliConnectionOptions {
  cwd?: string;
  env?: Record<string, string>;
  model?: string;
}

export class AcpCodexCliConnection implements AcpConnection {
  private readonly options: AcpCodexCliConnectionOptions;
  private readonly notificationHandlers = new Set<NotificationHandler>();
  private connected = true;
  private currentChild: { kill: () => void } | null = null;

  constructor(options: AcpCodexCliConnectionOptions = {}) {
    if (!Platform.isDesktop) {
      throw new Error('Codex CLI connection is only supported on Obsidian desktop');
    }
    this.options = options;
  }

  async sendRequest<TResult = unknown, TParams = unknown>(
    method: string,
    params?: TParams,
    signal?: AbortSignal,
  ): Promise<TResult> {
    if (!Platform.isDesktop) {
      throw new Error('Codex CLI connection is only supported on Obsidian desktop');
    }

    if (method === 'initialize') {
      return this.handleInitialize<TResult>();
    }

    if (method === 'session/new') {
      return this.handleSessionNew<TResult>();
    }

    if (method === 'session/prompt') {
      return this.handleSessionPrompt<TResult>(params, signal);
    }

    throw new Error(`Unsupported method for Codex CLI: ${method}`);
  }

  private async handleInitialize<TResult>(): Promise<TResult> {
    if (!Platform.isDesktop) {
      throw new Error('Codex CLI connection is only supported on Obsidian desktop');
    }

    const { execFile } = requireDesktopNodeModule<typeof import('node:child_process')>('node:child_process');

    const procEnv: Record<string, string | undefined> =
      typeof window !== 'undefined' && 'process' in window
        ? (window as unknown as { process: { env: Record<string, string | undefined> } }).process.env
        : {};
    const env = { ...procEnv, PATH: buildEnrichedPath(procEnv.PATH), ...this.options.env };

    return new Promise<TResult>((resolve, reject) => {
      execFile('codex', ['--version'], { env }, (error, stdout) => {
        if (error) {
          reject(
            new Error(
              `Codex CLI is not found or not executable. Please verify that 'codex' is installed and in your PATH (e.g. 'brew install codex' or 'npm install -g @openai/codex'). Error: ${error.message}`,
            ),
          );
          return;
        }
        const output = stdout.trim();
        const match = output.match(/(\d+\.\d+\.\d+)/);
        const version = match ? match[1] : '0.1.0';
        const result: AcpInitializeResult = {
          protocolVersion: 1,
          agentInfo: {
            name: 'OpenAI Codex',
            version,
          },
          capabilities: {
            streaming: true,
          },
        };
        resolve(result as TResult);
      });
    });
  }

  private handleSessionNew<TResult>(): Promise<TResult> {
    const sessionId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `session_${Date.now()}`;
    return Promise.resolve({ sessionId } as TResult);
  }

  private async handleSessionPrompt<TResult>(
    params?: unknown,
    signal?: AbortSignal,
  ): Promise<TResult> {
    if (!Platform.isDesktop) {
      throw new Error('Codex CLI connection is only supported on Obsidian desktop');
    }

    const promptParams = (params ?? {}) as {
      sessionId?: string;
      prompt?: string | Array<{ type: string; text?: string }>;
      model?: string;
      system?: string;
    };

    let promptText = '';
    if (typeof promptParams.prompt === 'string') {
      promptText = promptParams.prompt;
    } else if (Array.isArray(promptParams.prompt)) {
      promptText = promptParams.prompt
        .filter((p) => p && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string')
        .map((p) => String(p.text))
        .join('\n');
    }

    if (promptParams.system) {
      promptText = `${promptParams.system}\n\n${promptText}`;
    }

    const { spawn } = requireDesktopNodeModule<typeof import('node:child_process')>('node:child_process');

    const procEnv: Record<string, string | undefined> =
      typeof window !== 'undefined' && 'process' in window
        ? (window as unknown as { process: { env: Record<string, string | undefined> } }).process.env
        : {};
    const env = { ...procEnv, PATH: buildEnrichedPath(procEnv.PATH), ...this.options.env };

    const args = ['exec', '--json', '--skip-git-repo-check', '--ephemeral'];
    const targetModel = promptParams.model || this.options.model;
    if (targetModel && targetModel !== 'default') {
      args.push('-m', targetModel);
    }
    const cwd = this.options.cwd;
    if (cwd) {
      args.push('-C', cwd);
    }
    args.push('-');

    return new Promise<TResult>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('Request aborted'));
        return;
      }

      const child = spawn('codex', args, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.currentChild = child;

      const onAbort = () => {
        child.kill();
        this.currentChild = null;
        reject(new Error('Request aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      let collectedText = '';
      let collectedUsage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined;
      let stderrOutput = '';
      let stdoutBuffer = '';

      child.stdout.on('data', (chunk: unknown) => {
        stdoutBuffer += String(chunk);
        let newlineIndex: number;
        while ((newlineIndex = stdoutBuffer.indexOf('\n')) !== -1) {
          const line = stdoutBuffer.slice(0, newlineIndex).trim();
          stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
          if (!line) continue;

          try {
            const parsed = JSON.parse(line) as {
              type?: string;
              item?: { id?: string; type?: string; text?: string };
              usage?: { input_tokens?: number; output_tokens?: number };
            };

            if (parsed.type === 'item.completed' && parsed.item?.type === 'agent_message' && parsed.item.text) {
              collectedText += parsed.item.text;
              this.dispatchNotification({
                jsonrpc: '2.0',
                method: 'session/update',
                params: {
                  sessionId: promptParams.sessionId ?? 'default',
                  update: {
                    type: 'agent_message_chunk',
                    text: parsed.item.text,
                  },
                },
              });
            } else if (parsed.type === 'turn.completed' && parsed.usage) {
              collectedUsage = {
                promptTokens: parsed.usage.input_tokens,
                completionTokens: parsed.usage.output_tokens,
                totalTokens: (parsed.usage.input_tokens ?? 0) + (parsed.usage.output_tokens ?? 0),
              };
            }
          } catch {
            // Non-JSON line from codex
          }
        }
      });

      child.stderr?.on('data', (chunk: unknown) => {
        stderrOutput += String(chunk);
        if (stderrOutput.length > 2000) {
          stderrOutput = stderrOutput.slice(-2000);
        }
      });

      child.on('error', (err: Error) => {
        signal?.removeEventListener('abort', onAbort);
        this.currentChild = null;
        reject(new Error(`Failed to start Codex process: ${err.message}`));
      });

      child.on('exit', (code: number | null) => {
        signal?.removeEventListener('abort', onAbort);
        this.currentChild = null;

        if (code === 0) {
          const result: AcpPromptResult = {
            stopReason: 'end_turn',
            content: [{ type: 'text', text: collectedText }],
            usage: collectedUsage,
          };
          resolve(result as TResult);
        } else {
          reject(new Error(`Codex process exited with code ${code ?? 0}: ${stderrOutput.trim() || 'Unknown error'}`));
        }
      });

      child.stdin.write(promptText);
      child.stdin.end();
    });
  }

  private dispatchNotification(notification: JsonRpcNotification): void {
    for (const handler of this.notificationHandlers) {
      try {
        handler(notification);
      } catch {
        // ignore handler error
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
    if (this.currentChild) {
      this.currentChild.kill();
      this.currentChild = null;
    }
    this.notificationHandlers.clear();
  }

  isConnected(): boolean {
    return this.connected;
  }
}
