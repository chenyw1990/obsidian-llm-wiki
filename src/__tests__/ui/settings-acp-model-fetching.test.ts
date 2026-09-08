import { describe, it, expect } from 'vitest';
import { fetchAcpModels, getAcpPresetModels } from '../../llm-sdk/acp/acp-presets';

describe('Settings: ACP Model Fetching', () => {
  it('fetches codex preset models without HTTP errors', async () => {
    const models = await fetchAcpModels({
      acpAgentPreset: 'codex',
      acpTransport: 'stdio',
    });

    expect(models).toContain('default');
    expect(models).toContain('gpt-5.5');
    expect(models).toContain('gpt-5.4');
    expect(models).toContain('gpt-5.4-mini');
    expect(models.length).toBeGreaterThanOrEqual(5);
  });

  it('fetches claude-code preset models', async () => {
    const models = await fetchAcpModels({
      acpAgentPreset: 'claude-code',
      acpTransport: 'stdio',
    });

    expect(models).toContain('default');
    expect(models).toContain('claude-3-7-sonnet-latest');
    expect(models).toContain('claude-3-5-sonnet-latest');
  });

  it('fetches antigravity preset models', async () => {
    const models = await fetchAcpModels({
      acpAgentPreset: 'antigravity',
      acpTransport: 'stdio',
    });

    expect(models).toContain('default');
    expect(models).toContain('gemini-3.8-flash-high');
    expect(models).toContain('claude-sonnet-4-6');
  });

  it('incorporates OAuth codex models if cached', async () => {
    const models = await fetchAcpModels({
      acpAgentPreset: 'codex',
      openAICodexModels: [
        { slug: 'gpt-5.6-sol' },
        { slug: 'gpt-5.6-luna' },
      ],
    });

    expect(models).toContain('gpt-5.6-sol');
    expect(models).toContain('gpt-5.6-luna');
  });

  it('getAcpPresetModels provides synchronous defaults for preset switching', () => {
    const codex = getAcpPresetModels('codex');
    expect(codex).toContain('gpt-5.5');

    const claude = getAcpPresetModels('claude-code');
    expect(claude).toContain('claude-3-7-sonnet-latest');

    const agy = getAcpPresetModels('antigravity');
    expect(agy).toContain('gemini-3.8-flash-high');
  });
});
