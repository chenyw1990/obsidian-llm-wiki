import { wrapReasoningContent } from '../../core/markdown';
import type { LLMClient, MessageContentPart } from '../../types';
import type { AcpClient } from './acp-client';
import { forcedTextPromptSystem } from '../json-prompt-prefix';
import { fetchAcpModels, type AcpAgentPreset } from './acp-presets';

export interface AcpSdkClientOptions {
  acpClient: AcpClient;
  defaultModel?: string;
  preset?: AcpAgentPreset;
  transport?: string;
  baseUrl?: string;
}

function formatMessagesForAcp(
  messages: Array<{ role: 'user' | 'assistant'; content: string | MessageContentPart[] }>,
): string {
  if (messages.length === 1 && typeof messages[0].content === 'string') {
    return messages[0].content;
  }

  return messages
    .map((message) => {
      const roleLabel = message.role === 'user' ? 'User' : 'Assistant';
      const text =
        typeof message.content === 'string'
          ? message.content
          : message.content
              .filter((p) => p.type === 'text')
              .map((p) => (p as { text: string }).text)
              .join('\n');
      return `${roleLabel}:\n${text}`;
    })
    .join('\n\n');
}

export class AcpSdkClient implements LLMClient {
  private readonly acpClient: AcpClient;
  private readonly defaultModel: string;
  private readonly preset?: AcpAgentPreset;
  private readonly transport?: string;
  private readonly baseUrl?: string;

  constructor(options: AcpSdkClientOptions) {
    this.acpClient = options.acpClient;
    this.defaultModel = options.defaultModel ?? 'default';
    this.preset = options.preset;
    this.transport = options.transport;
    this.baseUrl = options.baseUrl;
  }

  async createMessage(params: Parameters<LLMClient['createMessage']>[0]): Promise<string> {
    const prompt = formatMessagesForAcp(params.messages);
    const system = forcedTextPromptSystem(
      params.system,
      params.response_format,
      params.outputModeOverride,
    );

    const response = await this.acpClient.prompt(prompt, {
      system,
      signal: params.abortSignal,
      model: params.model || this.defaultModel,
    });

    let text = response.text;
    if (params.enableThinking !== false && response.thought) {
      text = wrapReasoningContent(response.thought, text);
    }

    if (params.onFinish) {
      params.onFinish({
        finishReason: response.stopReason === 'max_tokens' ? 'length' : 'stop',
        usage: response.usage
          ? {
              inputTokens: response.usage.promptTokens ?? 0,
              outputTokens: response.usage.completionTokens ?? 0,
              totalTokens: response.usage.totalTokens ?? 0,
            }
          : undefined,
      });
    }

    return text;
  }

  async createMessageStream(
    params: Parameters<NonNullable<LLMClient['createMessageStream']>>[0],
  ): Promise<string> {
    const prompt = formatMessagesForAcp(params.messages);
    const system = params.system;

    const response = await this.acpClient.prompt(prompt, {
      system,
      onChunk: params.onChunk,
      model: params.model || this.defaultModel,
    });

    let text = response.text;
    if (params.enableThinking !== false && response.thought) {
      text = wrapReasoningContent(response.thought, text);
    }

    if (params.onFinish) {
      params.onFinish({
        finishReason: response.stopReason === 'max_tokens' ? 'length' : 'stop',
        usage: response.usage
          ? {
              inputTokens: response.usage.promptTokens ?? 0,
              outputTokens: response.usage.completionTokens ?? 0,
              totalTokens: response.usage.totalTokens ?? 0,
            }
          : undefined,
      });
    }

    return text;
  }

  async listModels(): Promise<string[]> {
    const models = await fetchAcpModels({
      acpAgentPreset: this.preset,
      acpTransport: this.transport,
      baseUrl: this.baseUrl,
    });
    const agentInfo = this.acpClient.getAgentInfo();
    if (agentInfo?.name && !models.includes(agentInfo.name)) {
      models.push(agentInfo.name);
    }
    return models;
  }
}
