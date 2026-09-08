import type { AcpConnection } from './acp-connection';
import type {
  AcpAgentInfo,
  AcpClientInfo,
  AcpContentPart,
  AcpInitializeParams,
  AcpInitializeResult,
  AcpNewSessionParams,
  AcpNewSessionResult,
  AcpPromptParams,
  AcpPromptResult,
  AcpSessionUpdateParams,
  AcpUsage,
  JsonRpcNotification,
} from './acp-types';

export interface AcpClientOptions {
  connection: AcpConnection;
  clientInfo?: AcpClientInfo;
  defaultCwd?: string;
}

export interface AcpPromptOptions {
  sessionId?: string;
  system?: string;
  model?: string;
  onChunk?: (text: string) => void;
  onThought?: (thought: string) => void;
  onUsage?: (usage: AcpUsage) => void;
  signal?: AbortSignal;
}

export interface AcpTurnResponse {
  text: string;
  thought: string;
  usage?: AcpUsage;
  stopReason?: string;
}

const DEFAULT_CLIENT_INFO: AcpClientInfo = {
  name: 'obsidian-llm-wiki',
  version: '1.27.1',
};

export class AcpClient {
  private readonly connection: AcpConnection;
  private readonly clientInfo: AcpClientInfo;
  private readonly defaultCwd?: string;
  private agentInfo: AcpAgentInfo | null = null;
  private capabilities: Record<string, unknown> | null = null;
  private initialized = false;
  private currentSessionId: string | null = null;

  constructor(options: AcpClientOptions) {
    this.connection = options.connection;
    this.clientInfo = options.clientInfo ?? DEFAULT_CLIENT_INFO;
    this.defaultCwd = options.defaultCwd;
  }

  async initialize(): Promise<AcpInitializeResult> {
    const params: AcpInitializeParams = {
      protocolVersion: 1,
      clientInfo: this.clientInfo,
      capabilities: {
        streaming: true,
      },
    };

    const result = await this.connection.sendRequest<AcpInitializeResult>('initialize', params);
    this.agentInfo = result.agentInfo ?? null;
    this.capabilities = result.capabilities ?? null;
    this.initialized = true;
    return result;
  }

  async createSession(cwd?: string): Promise<string> {
    if (!this.initialized) {
      await this.initialize();
    }

    const params: AcpNewSessionParams = {
      cwd: cwd ?? this.defaultCwd,
    };

    const result = await this.connection.sendRequest<AcpNewSessionResult>('session/new', params);
    this.currentSessionId = result.sessionId;
    return result.sessionId;
  }

  async prompt(
    prompt: string | AcpContentPart[],
    options?: AcpPromptOptions,
  ): Promise<AcpTurnResponse> {
    if (!this.initialized || !this.connection.isConnected()) {
      this.initialized = false;
      this.currentSessionId = null;
      await this.initialize();
    }

    let sessionId = options?.sessionId ?? this.currentSessionId;
    if (!sessionId) {
      sessionId = await this.createSession();
    }

    let collectedText = '';
    let collectedThought = '';
    let collectedUsage: AcpUsage | undefined;

    const unsubscribe = this.connection.onNotification((notification: JsonRpcNotification) => {
      if (notification.method === 'session/update' && notification.params) {
        const updateParams = notification.params as AcpSessionUpdateParams;
        if (updateParams.sessionId === sessionId) {
          const update = updateParams.update;
          if (update.type === 'agent_message_chunk' && typeof update.text === 'string') {
            collectedText += update.text;
            options?.onChunk?.(update.text);
          } else if (update.type === 'agent_thought_chunk' && typeof update.text === 'string') {
            collectedThought += update.text;
            options?.onThought?.(update.text);
          } else if (update.type === 'usage_update' && update.usage) {
            collectedUsage = update.usage;
            options?.onUsage?.(update.usage);
          }
        }
      }
    });

    try {
      const promptParams: AcpPromptParams = {
        sessionId,
        prompt,
        ...(options?.system ? { system: options.system } : {}),
        ...(options?.model ? { model: options.model } : {}),
      };

      const result = await this.connection.sendRequest<AcpPromptResult>(
        'session/prompt',
        promptParams,
        options?.signal,
      );

      // If no chunks were streamed but content is present in the final result
      if (!collectedText && result?.content && Array.isArray(result.content)) {
        for (const part of result.content) {
          if (part.type === 'text' && 'text' in part && typeof part.text === 'string') {
            collectedText += part.text;
            options?.onChunk?.(part.text);
          }
        }
      }

      if (result?.usage) {
        collectedUsage = result.usage;
      }

      return {
        text: collectedText,
        thought: collectedThought,
        usage: collectedUsage,
        stopReason: result?.stopReason,
      };
    } finally {
      unsubscribe();
    }
  }

  getAgentInfo(): AcpAgentInfo | null {
    return this.agentInfo;
  }

  getCapabilities(): Record<string, unknown> | null {
    return this.capabilities;
  }

  getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  async close(): Promise<void> {
    this.initialized = false;
    this.currentSessionId = null;
    await this.connection.close();
  }
}
