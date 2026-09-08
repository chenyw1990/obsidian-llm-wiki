import { describe, it, expect } from 'vitest';
import {
  ACP_PRESETS,
  ACP_PRESET_IDS,
  getAcpPresetDefaultCommand,
  isAcpCliPreset,
  getAcpPresetModels,
  fetchAcpModels,
} from '../../../llm-sdk/acp/acp-presets';

describe('ACP Agent Presets', () => {
  it('defines presets for Claude Code, OpenCode, Codex, and Antigravity CLI', () => {
    expect(ACP_PRESET_IDS).toContain('claude-code');
    expect(ACP_PRESET_IDS).toContain('opencode');
    expect(ACP_PRESET_IDS).toContain('codex');
    expect(ACP_PRESET_IDS).toContain('antigravity');
    expect(ACP_PRESET_IDS).toContain('custom');
  });

  it('maps correct default commands for each agent preset', () => {
    expect(getAcpPresetDefaultCommand('claude-code')).toBe('claude acp');
    expect(getAcpPresetDefaultCommand('opencode')).toBe('opencode acp');
    expect(getAcpPresetDefaultCommand('codex')).toBe('codex acp');
    expect(getAcpPresetDefaultCommand('antigravity')).toBe('agy acp');
    expect(getAcpPresetDefaultCommand('custom')).toBe('');
  });

  it('identifies CLI presets correctly', () => {
    expect(isAcpCliPreset('claude-code')).toBe(true);
    expect(isAcpCliPreset('opencode')).toBe(true);
    expect(isAcpCliPreset('codex')).toBe(true);
    expect(isAcpCliPreset('antigravity')).toBe(true);
    expect(isAcpCliPreset('custom')).toBe(false);
  });

  it('contains expected binary and metadata for each preset', () => {
    expect(ACP_PRESETS['claude-code'].cliBinary).toBe('claude');
    expect(ACP_PRESETS['opencode'].cliBinary).toBe('opencode');
    expect(ACP_PRESETS['codex'].cliBinary).toBe('codex');
    expect(ACP_PRESETS['antigravity'].cliBinary).toBe('agy');
  });

  it('provides default models for each agent preset', () => {
    const codexModels = getAcpPresetModels('codex');
    expect(codexModels).toContain('default');
    expect(codexModels).toContain('gpt-5.5');
    expect(codexModels).toContain('gpt-5.4');

    const claudeModels = getAcpPresetModels('claude-code');
    expect(claudeModels).toContain('default');
    expect(claudeModels).toContain('claude-3-7-sonnet-latest');

    const agyModels = getAcpPresetModels('antigravity');
    expect(agyModels).toContain('default');
    expect(agyModels).toContain('gemini-3.8-flash-high');
  });

  it('fetchAcpModels returns models and incorporates cached OAuth models', async () => {
    const models = await fetchAcpModels({
      acpAgentPreset: 'codex',
      openAICodexModels: [{ slug: 'gpt-custom-codex' }],
    });
    expect(models).toContain('gpt-custom-codex');
    expect(models).toContain('gpt-5.5');
    expect(models.length).toBeGreaterThan(3);
  });
});
