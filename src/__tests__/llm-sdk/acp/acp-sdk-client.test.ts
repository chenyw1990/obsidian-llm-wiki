import { describe, it, expect, vi } from 'vitest';
import { AcpSdkClient } from '../../../llm-sdk/acp/acp-sdk-client';
import type { AcpClient, AcpTurnResponse } from '../../../llm-sdk/acp/acp-client';

describe('AcpSdkClient', () => {
  function createMockAcpClient() {
    const prompt = vi.fn();
    const initialize = vi.fn().mockResolvedValue({ protocolVersion: '1' });
    const getAgentInfo = vi.fn().mockReturnValue({ name: 'claude-acp', version: '2.0.0' });
    const close = vi.fn().mockResolvedValue(undefined);

    const client = {
      prompt,
      initialize,
      getAgentInfo,
      close,
    } as unknown as AcpClient;

    return { client, prompt, initialize, getAgentInfo, close };
  }

  it('executes createMessage and returns text', async () => {
    const { client, prompt } = createMockAcpClient();
    prompt.mockResolvedValueOnce({
      text: 'Here is the summary of the note.',
      thought: '',
      stopReason: 'end_turn',
    } as AcpTurnResponse);

    const sdkClient = new AcpSdkClient({ acpClient: client });
    const result = await sdkClient.createMessage({
      model: 'default',
      max_tokens: 1000,
      messages: [
        { role: 'user', content: 'Summarize note' },
      ],
      system: 'You are an expert wiki generator.',
    });

    expect(result).toBe('Here is the summary of the note.');
    expect(prompt).toHaveBeenCalledTimes(1);
    const [promptArg, opts] = prompt.mock.calls[0];
    expect(promptArg).toContain('Summarize note');
    expect(opts.system).toBe('You are an expert wiki generator.');
  });

  it('wraps reasoning thought when agent_thought_chunk is returned', async () => {
    const { client, prompt } = createMockAcpClient();
    prompt.mockResolvedValueOnce({
      text: 'Final conclusion.',
      thought: 'Step-by-step reasoning analysis.',
      stopReason: 'end_turn',
    } as AcpTurnResponse);

    const sdkClient = new AcpSdkClient({ acpClient: client });
    const result = await sdkClient.createMessage({
      model: 'default',
      max_tokens: 1000,
      messages: [{ role: 'user', content: 'Reason through this' }],
      enableThinking: true,
    });

    expect(result).toContain('<think>');
    expect(result).toContain('Step-by-step reasoning analysis.');
    expect(result).toContain('</think>');
    expect(result).toContain('Final conclusion.');
  });

  it('streams chunks via createMessageStream', async () => {
    const { client, prompt } = createMockAcpClient();
    prompt.mockImplementation(async (_p, opts) => {
      opts.onChunk?.('Streamed chunk 1. ');
      opts.onChunk?.('Streamed chunk 2.');
      return {
        text: 'Streamed chunk 1. Streamed chunk 2.',
        thought: '',
        stopReason: 'end_turn',
      };
    });

    const sdkClient = new AcpSdkClient({ acpClient: client });
    const chunks: string[] = [];

    const result = await sdkClient.createMessageStream({
      model: 'default',
      max_tokens: 1000,
      messages: [{ role: 'user', content: 'Stream test' }],
      onChunk: (c) => chunks.push(c),
    });

    expect(result).toBe('Streamed chunk 1. Streamed chunk 2.');
    expect(chunks).toEqual(['Streamed chunk 1. ', 'Streamed chunk 2.']);
  });

  it('listModels returns default and agent name', async () => {
    const { client } = createMockAcpClient();
    const sdkClient = new AcpSdkClient({ acpClient: client });
    const models = await sdkClient.listModels();
    expect(models).toContain('default');
    expect(models).toContain('claude-acp');
  });
});
