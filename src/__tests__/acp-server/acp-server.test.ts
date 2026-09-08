import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AcpServer, handleAcpRpcMessage } from '../../acp-server/acp-server';
import type { JsonRpcRequest } from '../../llm-sdk/acp/acp-types';

describe('handleAcpRpcMessage', () => {
  it('handles initialize request', async () => {
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: 1, clientInfo: { name: 'zed', version: '0.1.0' } },
    };

    const response = await handleAcpRpcMessage(request, {
      queryEngine: null,
    });

    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 1,
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
    });
  });

  it('handles session/new request', async () => {
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: '/vault' },
    };

    const response = await handleAcpRpcMessage(request, {
      queryEngine: null,
    });

    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBe(2);
    expect(response.result).toHaveProperty('sessionId');
  });

  it('handles session/prompt request delegating to QueryEngine', async () => {
    const mockQueryEngine = {
      queryStream: vi.fn().mockImplementation(async (q, onChunk) => {
        onChunk('Knowledge answer with [[link]]');
        return 'Knowledge answer with [[link]]';
      }),
    };

    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: {
        sessionId: 'session-1',
        prompt: 'What is PPR?',
      },
    };

    const notifications: unknown[] = [];
    const response = await handleAcpRpcMessage(request, {
      queryEngine: mockQueryEngine as any,
      onNotification: (n) => notifications.push(n),
    });

    expect(mockQueryEngine.queryStream).toHaveBeenCalledWith(
      'What is PPR?',
      expect.any(Function),
      expect.any(Function),
    );
    expect(notifications.length).toBeGreaterThanOrEqual(1);
    expect(response.result).toMatchObject({
      stopReason: 'end_turn',
      content: [{ type: 'text', text: 'Knowledge answer with [[link]]' }],
    });
  });

  it('returns method not found for unknown methods', async () => {
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 99,
      method: 'unknown/method',
    };

    const response = await handleAcpRpcMessage(request, { queryEngine: null });
    expect(response.error).toMatchObject({
      code: -32601,
      message: 'Method not found',
    });
  });
});
