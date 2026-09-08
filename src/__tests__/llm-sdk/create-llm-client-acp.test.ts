import { describe, it, expect, beforeEach } from 'vitest';
import {
  createLLMClientFromSettings,
  createLLMClientFromSettingsSync,
  preloadLLMClientModules,
  _resetPreloadedModulesForTests,
} from '../../llm-sdk/create-llm-client';
import { AcpSdkClient } from '../../llm-sdk/acp/acp-sdk-client';
import type { AcpConnection } from '../../llm-sdk/acp/acp-connection';

function createMockAcpConnection(): AcpConnection {
  return {
    sendRequest: async <TResult = unknown>(method: string): Promise<TResult> => {
      if (method === 'initialize') return { protocolVersion: '1' } as unknown as TResult;
      if (method === 'session/new') return { sessionId: 'test-session' } as unknown as TResult;
      return { stopReason: 'end_turn' } as unknown as TResult;
    },
    onNotification: () => () => {},
    close: async () => {},
    isConnected: () => true,
  };
}

describe('createLLMClientFromSettings with ACP provider', () => {
  beforeEach(() => {
    _resetPreloadedModulesForTests();
  });

  it('asynchronously constructs AcpSdkClient when provider is acp', async () => {
    const mockConn = createMockAcpConnection();
    const client = await createLLMClientFromSettings({
      provider: 'acp',
      apiKey: '',
      providerApiKeySecretId: 'karpathywiki-provider-api-key',
      acpConnection: mockConn,
    });

    expect(client).toBeInstanceOf(AcpSdkClient);
  });

  it('synchronously constructs AcpSdkClient after preloadLLMClientModules', async () => {
    await preloadLLMClientModules();
    const mockConn = createMockAcpConnection();

    const client = createLLMClientFromSettingsSync({
      provider: 'acp',
      apiKey: '',
      providerApiKeySecretId: 'karpathywiki-provider-api-key',
      acpConnection: mockConn,
    });

    expect(client).toBeInstanceOf(AcpSdkClient);
  });
});
