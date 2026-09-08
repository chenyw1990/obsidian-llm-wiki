import { Platform } from 'obsidian';
import { AcpClient } from './acp-client';
import {
  AcpHttpConnection,
  AcpWebSocketConnection,
  AcpStdioConnection,
  type AcpConnection,
} from './acp-connection';
import { AcpCodexCliConnection } from './acp-codex-connection';
import { AcpClaudeCliConnection } from './acp-claude-connection';
import { getAcpPresetDefaultCommand } from './acp-presets';
import { AcpSdkClient } from './acp-sdk-client';
import type { ProviderSettings } from '../create-llm-client';

export interface CreateAcpClientOptions {
  settings: ProviderSettings;
  apiKey?: string;
}

export function isCodexCliCommand(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed.includes('codex-acp')) return false;
  return trimmed === 'codex' || trimmed.startsWith('codex ') || trimmed.endsWith('/codex');
}

export function isClaudeCliCommand(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed.includes('claude-agent-acp') || trimmed.includes('claude-acp')) return false;
  return trimmed === 'claude' || trimmed.startsWith('claude ') || trimmed.endsWith('/claude');
}

export function isAgyCliCommand(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed.includes('agy-acp') || trimmed.includes('antigravity-acp')) return false;
  return trimmed === 'agy' || trimmed.startsWith('agy ') || trimmed.endsWith('/agy');
}

export function createAcpConnection(settings: Partial<ProviderSettings>, apiKey?: string): AcpConnection {
  const transport = settings.acpTransport ?? 'http';
  const baseUrl = settings.baseUrl?.trim() || '';

  if (transport === 'stdio') {
    const fallbackCommand = settings.acpAgentPreset
      ? getAcpPresetDefaultCommand(settings.acpAgentPreset)
      : 'claude acp';
    const command = settings.acpCommand?.trim() || fallbackCommand || 'claude acp';

    if (Platform.isDesktop) {
      if (isCodexCliCommand(command)) {
        return new AcpCodexCliConnection({
          cwd: settings.acpCwd,
          model: settings.model,
        });
      }
      if (isClaudeCliCommand(command)) {
        return new AcpClaudeCliConnection({
          binary: 'claude',
          cwd: settings.acpCwd,
          model: settings.model,
        });
      }
      if (isAgyCliCommand(command)) {
        return new AcpClaudeCliConnection({
          binary: 'agy',
          cwd: settings.acpCwd,
          model: settings.model,
        });
      }
    }

    return new AcpStdioConnection({
      command,
      cwd: settings.acpCwd,
    });
  }

  if (transport === 'websocket' || baseUrl.startsWith('ws://') || baseUrl.startsWith('wss://')) {
    return new AcpWebSocketConnection({
      url: baseUrl || 'ws://localhost:3000',
      apiKey,
    });
  }

  return new AcpHttpConnection({
    baseUrl: baseUrl || 'http://localhost:3000',
    apiKey,
  });
}

export function createAcpSdkClient(settings: ProviderSettings, apiKey?: string): AcpSdkClient {
  const connection = settings.acpConnection ?? createAcpConnection(settings, apiKey);
  const acpClient = new AcpClient({
    connection,
    defaultCwd: settings.acpCwd,
  });
  return new AcpSdkClient({
    acpClient,
    defaultModel: settings.model,
    preset: settings.acpAgentPreset,
    transport: settings.acpTransport,
    baseUrl: settings.baseUrl,
  });
}
