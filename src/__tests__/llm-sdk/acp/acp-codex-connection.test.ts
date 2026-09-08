import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  isCodexCliCommand,
  isClaudeCliCommand,
  isAgyCliCommand,
  createAcpConnection,
} from '../../../llm-sdk/acp/create-acp-client';
import { AcpCodexCliConnection } from '../../../llm-sdk/acp/acp-codex-connection';
import { AcpClaudeCliConnection } from '../../../llm-sdk/acp/acp-claude-connection';
import { AcpStdioConnection } from '../../../llm-sdk/acp/acp-connection';
import { requireDesktopNodeModule } from '../../../llm-sdk/acp/desktop-node-require';
import type { AcpInitializeResult, AcpPromptResult } from '../../../llm-sdk/acp/acp-types';

describe('requireDesktopNodeModule', () => {
  it('uses Obsidian desktop window require instead of an ESM node:module import', () => {
    const runtimeWindow = activeWindow as unknown as { require?: (moduleId: string) => unknown };
    const previousRequire = runtimeWindow.require;
    const childProcess = { execFile: vi.fn() };
    const runtimeRequire = vi.fn().mockReturnValue(childProcess);
    runtimeWindow.require = runtimeRequire;

    try {
      expect(requireDesktopNodeModule<typeof childProcess>('node:child_process')).toBe(childProcess);
      expect(runtimeRequire).toHaveBeenCalledWith('node:child_process');
    } finally {
      runtimeWindow.require = previousRequire;
    }
  });
});

describe('ACP CLI Command Matchers', () => {
  it('correctly identifies Codex CLI commands vs ACP servers', () => {
    expect(isCodexCliCommand('codex')).toBe(true);
    expect(isCodexCliCommand('codex acp')).toBe(true);
    expect(isCodexCliCommand('codex exec')).toBe(true);
    expect(isCodexCliCommand('/opt/homebrew/bin/codex')).toBe(true);
    expect(isCodexCliCommand('codex-acp')).toBe(false);
    expect(isCodexCliCommand('npx -y @agentclientprotocol/codex-acp')).toBe(false);
    expect(isCodexCliCommand('opencode acp')).toBe(false);
  });

  it('correctly identifies Claude CLI commands vs ACP servers', () => {
    expect(isClaudeCliCommand('claude')).toBe(true);
    expect(isClaudeCliCommand('claude acp')).toBe(true);
    expect(isClaudeCliCommand('/opt/homebrew/bin/claude')).toBe(true);
    expect(isClaudeCliCommand('claude-agent-acp')).toBe(false);
    expect(isClaudeCliCommand('claude-acp')).toBe(false);
  });

  it('correctly identifies Antigravity CLI commands', () => {
    expect(isAgyCliCommand('agy')).toBe(true);
    expect(isAgyCliCommand('agy acp')).toBe(true);
    expect(isAgyCliCommand('agy-acp')).toBe(false);
  });
});

describe('createAcpConnection routing', () => {
  it('routes codex commands to AcpCodexCliConnection', () => {
    const conn = createAcpConnection({
      acpTransport: 'stdio',
      acpCommand: 'codex acp',
      acpAgentPreset: 'codex',
    });
    expect(conn).toBeInstanceOf(AcpCodexCliConnection);
  });

  it('routes claude commands to AcpClaudeCliConnection', () => {
    const conn = createAcpConnection({
      acpTransport: 'stdio',
      acpCommand: 'claude acp',
      acpAgentPreset: 'claude-code',
    });
    expect(conn).toBeInstanceOf(AcpClaudeCliConnection);
  });

  it('routes opencode acp to standard AcpStdioConnection', () => {
    const conn = createAcpConnection({
      acpTransport: 'stdio',
      acpCommand: 'opencode acp',
      acpAgentPreset: 'opencode',
    });
    expect(conn).toBeInstanceOf(AcpStdioConnection);
  });

  it('routes explicit codex-acp to standard AcpStdioConnection', () => {
    const conn = createAcpConnection({
      acpTransport: 'stdio',
      acpCommand: 'codex-acp',
      acpAgentPreset: 'codex',
    });
    expect(conn).toBeInstanceOf(AcpStdioConnection);
  });
});

describe('AcpCodexCliConnection', () => {
  let mockExecFile: ReturnType<typeof vi.fn>;
  let mockSpawn: ReturnType<typeof vi.fn>;
  let previousRequire: unknown;

  beforeEach(async () => {
    const nodeModule = await import('node:module');
    // eslint-disable-next-line no-undef -- test environment
    const nodeRequire = nodeModule.Module.createRequire(__filename);
    const cp = nodeRequire('node:child_process') as typeof import('node:child_process');
    const runtimeWindow = activeWindow as unknown as { require?: unknown };
    previousRequire = runtimeWindow.require;
    runtimeWindow.require = nodeRequire;

    mockExecFile = vi.fn();
    mockSpawn = vi.fn();
    vi.spyOn(cp, 'execFile').mockImplementation(mockExecFile as any);
    vi.spyOn(cp, 'spawn').mockImplementation(mockSpawn as any);
  });

  afterEach(() => {
    (activeWindow as unknown as { require?: unknown }).require = previousRequire;
    vi.restoreAllMocks();
  });

  it('initializes by checking codex version', async () => {
    mockExecFile.mockImplementation((bin, args, opts, callback) => {
      callback(null, 'OpenAI Codex 0.149.0\n');
    });

    const conn = new AcpCodexCliConnection();
    const result = await conn.sendRequest<AcpInitializeResult>('initialize');

    expect(result.protocolVersion).toBe(1);
    expect(result.agentInfo?.name).toBe('OpenAI Codex');
    expect(result.agentInfo?.version).toBe('0.149.0');
    expect(result.capabilities?.streaming).toBe(true);
  });

  it('creates new session with unique id', async () => {
    const conn = new AcpCodexCliConnection();
    const result = await conn.sendRequest<{ sessionId: string }>('session/new');
    expect(typeof result.sessionId).toBe('string');
    expect(result.sessionId.length).toBeGreaterThan(0);
  });

  it('executes prompt with streaming chunks and returns result', async () => {
    const mockChild = new EventEmitter() as any;
    mockChild.stdout = new EventEmitter();
    mockChild.stderr = new EventEmitter();
    mockChild.stdin = {
      write: vi.fn(),
      end: vi.fn(),
    };
    mockChild.kill = vi.fn();

    mockSpawn.mockReturnValue(mockChild);

    const conn = new AcpCodexCliConnection({ model: 'gpt-5.4-mini' });
    const notificationEvents: any[] = [];
    conn.onNotification((n) => notificationEvents.push(n));

    const promptPromise = conn.sendRequest<AcpPromptResult>('session/prompt', {
      sessionId: 'session-123',
      prompt: 'Hello Codex',
    });

    // Simulate stdout stream from codex exec --json
    setTimeout(() => {
      mockChild.stdout.emit(
        'data',
        Buffer.from(
          JSON.stringify({
            type: 'item.completed',
            item: { id: 'item_0', type: 'agent_message', text: 'Hello from Codex!' },
          }) + '\n',
        ),
      );
      mockChild.stdout.emit(
        'data',
        Buffer.from(
          JSON.stringify({
            type: 'turn.completed',
            usage: { input_tokens: 100, output_tokens: 25 },
          }) + '\n',
        ),
      );
      mockChild.emit('exit', 0);
    }, 10);

    const result = await promptPromise;

    expect(result.stopReason).toBe('end_turn');
    expect(result.content).toEqual([{ type: 'text', text: 'Hello from Codex!' }]);
    expect(result.usage).toEqual({
      promptTokens: 100,
      completionTokens: 25,
      totalTokens: 125,
    });

    expect(notificationEvents.length).toBe(1);
    expect(notificationEvents[0].params.update).toEqual({
      type: 'agent_message_chunk',
      text: 'Hello from Codex!',
    });
    expect(mockChild.stdin.write).toHaveBeenCalledWith('Hello Codex');
    expect(mockChild.stdin.end).toHaveBeenCalled();
  });
});

describe('AcpClaudeCliConnection', () => {
  let mockExecFile: ReturnType<typeof vi.fn>;
  let mockSpawn: ReturnType<typeof vi.fn>;
  let previousRequire: unknown;

  beforeEach(async () => {
    const nodeModule = await import('node:module');
    // eslint-disable-next-line no-undef -- test environment
    const nodeRequire = nodeModule.Module.createRequire(__filename);
    const cp = nodeRequire('node:child_process') as typeof import('node:child_process');
    const runtimeWindow = activeWindow as unknown as { require?: unknown };
    previousRequire = runtimeWindow.require;
    runtimeWindow.require = nodeRequire;

    mockExecFile = vi.fn();
    mockSpawn = vi.fn();
    vi.spyOn(cp, 'execFile').mockImplementation(mockExecFile as any);
    vi.spyOn(cp, 'spawn').mockImplementation(mockSpawn as any);
  });

  afterEach(() => {
    (activeWindow as unknown as { require?: unknown }).require = previousRequire;
    vi.restoreAllMocks();
  });

  it('initializes by checking claude version', async () => {
    mockExecFile.mockImplementation((bin, args, opts, callback) => {
      callback(null, 'claude 2.1.231\n');
    });

    const conn = new AcpClaudeCliConnection();
    const result = await conn.sendRequest<AcpInitializeResult>('initialize');

    expect(result.protocolVersion).toBe(1);
    expect(result.agentInfo?.name).toBe('Claude Code');
    expect(result.agentInfo?.version).toBe('2.1.231');
    expect(result.capabilities?.streaming).toBe(true);
  });

  it('executes prompt with stream-json chunks and returns result', async () => {
    const mockChild = new EventEmitter() as any;
    mockChild.stdout = new EventEmitter();
    mockChild.stderr = new EventEmitter();
    mockChild.kill = vi.fn();

    mockSpawn.mockReturnValue(mockChild);

    const conn = new AcpClaudeCliConnection();
    const notificationEvents: any[] = [];
    conn.onNotification((n) => notificationEvents.push(n));

    const promptPromise = conn.sendRequest<AcpPromptResult>('session/prompt', {
      sessionId: 'session-456',
      prompt: 'Hello Claude',
    });

    setTimeout(() => {
      mockChild.stdout.emit(
        'data',
        Buffer.from(
          JSON.stringify({
            type: 'assistant',
            message: {
              content: [{ type: 'text', text: 'Hello from Claude!' }],
            },
          }) + '\n',
        ),
      );
      mockChild.stdout.emit(
        'data',
        Buffer.from(
          JSON.stringify({
            type: 'result',
            result: 'Hello from Claude!',
            usage: { input_tokens: 50, output_tokens: 15 },
          }) + '\n',
        ),
      );
      mockChild.emit('exit', 0);
    }, 10);

    const result = await promptPromise;

    expect(result.stopReason).toBe('end_turn');
    expect(result.content).toEqual([{ type: 'text', text: 'Hello from Claude!' }]);
    expect(result.usage).toEqual({
      promptTokens: 50,
      completionTokens: 15,
      totalTokens: 65,
    });
    expect(notificationEvents.length).toBe(1);
    expect(notificationEvents[0].params.update).toEqual({
      type: 'agent_message_chunk',
      text: 'Hello from Claude!',
    });
  });
});
