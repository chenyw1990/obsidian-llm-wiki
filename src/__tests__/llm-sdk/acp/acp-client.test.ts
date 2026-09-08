import { describe, it, expect, vi } from 'vitest';
import { AcpClient } from '../../../llm-sdk/acp/acp-client';
import type { AcpConnection, NotificationHandler } from '../../../llm-sdk/acp/acp-connection';
import type { JsonRpcNotification } from '../../../llm-sdk/acp/acp-types';

describe('AcpClient', () => {
  function createMockConnection() {
    const handlers = new Set<NotificationHandler>();
    const sendRequest = vi.fn();
    const close = vi.fn().mockResolvedValue(undefined);
    const isConnected = vi.fn().mockReturnValue(true);

    const conn: AcpConnection = {
      sendRequest,
      onNotification: (h) => {
        handlers.add(h);
        return () => handlers.delete(h);
      },
      close,
      isConnected,
    };

    const emitNotification = (n: JsonRpcNotification) => {
      for (const h of handlers) h(n);
    };

    return { conn, sendRequest, emitNotification, close };
  }

  it('performs initialize handshake and stores agentInfo', async () => {
    const { conn, sendRequest } = createMockConnection();
    sendRequest.mockResolvedValueOnce({
      protocolVersion: '1',
      agentInfo: { name: 'claude-code', version: '1.2.0' },
    });

    const client = new AcpClient({ connection: conn });
    const result = await client.initialize();

    expect(result.protocolVersion).toBe('1');
    expect(client.getAgentInfo()?.name).toBe('claude-code');
    expect(sendRequest).toHaveBeenCalledWith('initialize', expect.objectContaining({
      protocolVersion: 1,
      clientInfo: expect.objectContaining({ name: 'obsidian-llm-wiki' }),
    }));
  });

  it('creates new session with session/new', async () => {
    const { conn, sendRequest } = createMockConnection();
    sendRequest
      .mockResolvedValueOnce({ protocolVersion: '1' })
      .mockResolvedValueOnce({ sessionId: 'session-42' });

    const client = new AcpClient({ connection: conn });
    const sessionId = await client.createSession('/path/to/vault');

    expect(sessionId).toBe('session-42');
    expect(sendRequest).toHaveBeenCalledWith('session/new', expect.objectContaining({
      cwd: '/path/to/vault',
    }));
  });

  it('handles prompt turn with streaming message chunks and thought chunks', async () => {
    const { conn, sendRequest, emitNotification } = createMockConnection();
    sendRequest
      .mockResolvedValueOnce({ protocolVersion: '1' })
      .mockResolvedValueOnce({ sessionId: 's1' })
      .mockImplementation(async (method) => {
        if (method === 'session/prompt') {
          // Emit thought chunk
          emitNotification({
            jsonrpc: '2.0',
            method: 'session/update',
            params: { sessionId: 's1', update: { type: 'agent_thought_chunk', text: 'Thinking step 1... ' } },
          });
          // Emit message chunks
          emitNotification({
            jsonrpc: '2.0',
            method: 'session/update',
            params: { sessionId: 's1', update: { type: 'agent_message_chunk', text: 'Answer part 1. ' } },
          });
          emitNotification({
            jsonrpc: '2.0',
            method: 'session/update',
            params: { sessionId: 's1', update: { type: 'agent_message_chunk', text: 'Answer part 2.' } },
          });
          return { stopReason: 'end_turn' };
        }
      });

    const client = new AcpClient({ connection: conn });
    const chunks: string[] = [];
    const thoughts: string[] = [];

    const response = await client.prompt('Explain PPR', {
      onChunk: (c) => chunks.push(c),
      onThought: (t) => thoughts.push(t),
    });

    expect(response.text).toBe('Answer part 1. Answer part 2.');
    expect(response.thought).toBe('Thinking step 1... ');
    expect(response.stopReason).toBe('end_turn');
    expect(chunks).toEqual(['Answer part 1. ', 'Answer part 2.']);
    expect(thoughts).toEqual(['Thinking step 1... ']);
  });

  it('falls back to result.content when no chunks are streamed', async () => {
    const { conn, sendRequest } = createMockConnection();
    sendRequest
      .mockResolvedValueOnce({ protocolVersion: '1' })
      .mockResolvedValueOnce({ sessionId: 's1' })
      .mockResolvedValueOnce({
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'Direct response text' }],
      });

    const client = new AcpClient({ connection: conn });
    const response = await client.prompt('Hello');

    expect(response.text).toBe('Direct response text');
    expect(response.stopReason).toBe('end_turn');
  });
});
