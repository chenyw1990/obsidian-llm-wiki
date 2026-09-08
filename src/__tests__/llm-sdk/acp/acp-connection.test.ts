import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AcpHttpConnection, AcpWebSocketConnection } from '../../../llm-sdk/acp/acp-connection';
import type { JsonRpcResponse, JsonRpcNotification } from '../../../llm-sdk/acp/acp-types';

describe('AcpHttpConnection', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('sends JSON-RPC request and parses response result', async () => {
    const mockResponse: JsonRpcResponse<{ protocolVersion: string }> = {
      jsonrpc: '2.0',
      id: 1,
      result: { protocolVersion: '1' },
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => mockResponse,
      text: async () => JSON.stringify(mockResponse),
    } as unknown as Response);

    const conn = new AcpHttpConnection({
      baseUrl: 'http://localhost:3000',
      apiKey: 'test-token',
    });

    const result = await conn.sendRequest<{ protocolVersion: string }>('initialize', {
      protocolVersion: '1',
      clientInfo: { name: 'test', version: '1.0' },
    });

    expect(result).toEqual({ protocolVersion: '1' });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('http://localhost:3000');
    expect(init?.headers).toMatchObject({
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-token',
    });
    const body = JSON.parse(init?.body as string);
    expect(body.method).toBe('initialize');
    expect(body.jsonrpc).toBe('2.0');
  });

  it('throws when server returns JSON-RPC error', async () => {
    const mockResponse: JsonRpcResponse = {
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32601, message: 'Method not found' },
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => mockResponse,
      text: async () => JSON.stringify(mockResponse),
    } as unknown as Response);

    const conn = new AcpHttpConnection({ baseUrl: 'http://localhost:3000' });
    await expect(conn.sendRequest('unknown_method')).rejects.toThrow('Method not found');
  });

  it('throws on HTTP error status', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => 'Invalid token',
    } as unknown as Response);

    const conn = new AcpHttpConnection({ baseUrl: 'http://localhost:3000' });
    await expect(conn.sendRequest('initialize')).rejects.toThrow('HTTP 401');
  });

  it('dispatches notifications from newline-delimited stream', async () => {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 's1',
        update: { type: 'agent_message_chunk', text: 'Hello world' },
      },
    };
    const finalResponse: JsonRpcResponse = {
      jsonrpc: '2.0',
      id: 1,
      result: { stopReason: 'end_turn' },
    };

    const streamData = `${JSON.stringify(notification)}\n${JSON.stringify(finalResponse)}\n`;
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(streamData));
        controller.close();
      },
    });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/x-ndjson' }),
      body: stream,
      text: async () => streamData,
    } as unknown as Response);

    const conn = new AcpHttpConnection({ baseUrl: 'http://localhost:3000' });
    const notifications: JsonRpcNotification[] = [];
    conn.onNotification((n) => notifications.push(n));

    const result = await conn.sendRequest('session/prompt', { sessionId: 's1', prompt: 'hi' });
    expect(result).toEqual({ stopReason: 'end_turn' });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].method).toBe('session/update');
  });
});
describe('AcpWebSocketConnection', () => {
  class MockWebSocket {
    static instances: MockWebSocket[] = [];
    url: string;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    onclose: (() => void) | null = null;
    readyState = 0; // CONNECTING
    sentMessages: string[] = [];

    constructor(url: string) {
      this.url = url;
      MockWebSocket.instances.push(this);
      setTimeout(() => {
        this.readyState = 1; // OPEN
        this.onopen?.();
      }, 0);
    }

    send(data: string) {
      this.sentMessages.push(data);
    }

    close() {
      this.readyState = 3; // CLOSED
      this.onclose?.();
    }
  }

  const originalWs = globalThis.WebSocket;

  beforeEach(() => {
    MockWebSocket.instances = [];
    (globalThis as unknown as Record<string, unknown>).WebSocket = MockWebSocket;
  });

  afterEach(() => {
    (globalThis as unknown as Record<string, unknown>).WebSocket = originalWs;
  });

  it('sends request and receives matched response via WebSocket', async () => {
    const conn = new AcpWebSocketConnection({ url: 'ws://localhost:3000/acp' });

    const promise = conn.sendRequest<{ agentName: string }>('initialize', { protocolVersion: '1' });

    // Wait for mock WS to open
    await new Promise((resolve) => setTimeout(resolve, 5));
    const ws = MockWebSocket.instances[0];
    expect(ws).toBeDefined();
    expect(ws.sentMessages.length).toBe(1);

    const sent = JSON.parse(ws.sentMessages[0]);
    expect(sent.method).toBe('initialize');

    // Simulate response from agent
    ws.onmessage?.({
      data: JSON.stringify({
        jsonrpc: '2.0',
        id: sent.id,
        result: { agentName: 'test-agent' },
      }),
    });

    const result = await promise;
    expect(result).toEqual({ agentName: 'test-agent' });
    await conn.close();
  });

  it('dispatches incoming notifications to handler', async () => {
    const conn = new AcpWebSocketConnection({ url: 'ws://localhost:3000/acp' });
    const notifications: JsonRpcNotification[] = [];
    conn.onNotification((n) => notifications.push(n));

    await conn.connect();
    const ws = MockWebSocket.instances[0];
    expect(ws).toBeDefined();

    ws.onmessage?.({
      data: JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: 's1', update: { type: 'agent_message_chunk', text: 'chunk1' } },
      }),
    });

    expect(notifications).toHaveLength(1);
    expect(notifications[0].params).toMatchObject({
      sessionId: 's1',
      update: { type: 'agent_message_chunk', text: 'chunk1' },
    });

    await conn.close();
  });
});

describe('buildEnrichedPath', () => {
  it('enriches empty PATH with standard tool binary locations', async () => {
    const { buildEnrichedPath } = await import('../../../llm-sdk/acp/acp-connection');
    const path = buildEnrichedPath('');
    expect(path).toContain('/opt/homebrew/bin');
    expect(path).toContain('/usr/local/bin');
    expect(path).toContain('/bin');
  });

  it('preserves existing PATH directories and avoids duplicates', async () => {
    const { buildEnrichedPath } = await import('../../../llm-sdk/acp/acp-connection');
    const path = buildEnrichedPath('/custom/bin:/opt/homebrew/bin');
    expect(path.startsWith('/custom/bin')).toBe(true);
    const parts = path.split(':');
    const homebrewCount = parts.filter((p) => p === '/opt/homebrew/bin').length;
    expect(homebrewCount).toBe(1);
  });
});
