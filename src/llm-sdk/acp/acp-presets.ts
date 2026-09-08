import { Platform } from 'obsidian';
import { requireDesktopNodeModule } from './desktop-node-require';

export type AcpAgentPreset = 'claude-code' | 'opencode' | 'codex' | 'antigravity' | 'custom';

export interface AcpPresetConfig {
  id: AcpAgentPreset;
  nameKey: string;
  defaultCommand: string;
  descriptionKey: string;
  cliBinary: string;
}

export const ACP_PRESETS: Record<AcpAgentPreset, AcpPresetConfig> = {
  'claude-code': {
    id: 'claude-code',
    nameKey: 'acpPresetClaudeCode',
    defaultCommand: 'claude acp',
    descriptionKey: 'acpPresetClaudeCodeDesc',
    cliBinary: 'claude',
  },
  'opencode': {
    id: 'opencode',
    nameKey: 'acpPresetOpenCode',
    defaultCommand: 'opencode acp',
    descriptionKey: 'acpPresetOpenCodeDesc',
    cliBinary: 'opencode',
  },
  'codex': {
    id: 'codex',
    nameKey: 'acpPresetCodex',
    defaultCommand: 'codex acp',
    descriptionKey: 'acpPresetCodexDesc',
    cliBinary: 'codex',
  },
  'antigravity': {
    id: 'antigravity',
    nameKey: 'acpPresetAntigravity',
    defaultCommand: 'agy acp',
    descriptionKey: 'acpPresetAntigravityDesc',
    cliBinary: 'agy',
  },
  'custom': {
    id: 'custom',
    nameKey: 'acpPresetCustom',
    defaultCommand: '',
    descriptionKey: 'acpPresetCustomDesc',
    cliBinary: '',
  },
};

export const ACP_PRESET_IDS: AcpAgentPreset[] = [
  'claude-code',
  'opencode',
  'codex',
  'antigravity',
  'custom',
];

export function getAcpPresetDefaultCommand(preset: AcpAgentPreset): string {
  return ACP_PRESETS[preset]?.defaultCommand ?? '';
}

export function isAcpCliPreset(preset: AcpAgentPreset): boolean {
  return preset !== 'custom';
}

export const ACP_PRESET_MODELS: Record<AcpAgentPreset, readonly string[]> = {
  'codex': [
    'default',
    'gpt-5.6-terra',
    'gpt-5.5',
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.3-codex-spark',
    'o3',
    'o3-mini',
    'o1',
    'gpt-4o',
  ],
  'claude-code': [
    'default',
    'claude-3-7-sonnet-latest',
    'claude-3-5-sonnet-latest',
    'claude-3-5-haiku-latest',
    'claude-opus-latest',
  ],
  'opencode': [
    'default',
  ],
  'antigravity': [
    'default',
    'gemini-3.8-flash-high',
    'gemini-3.8-flash-medium',
    'gemini-3.7-flash-high',
    'gemini-3.6-flash-high',
    'gemini-3.1-pro-high',
    'claude-sonnet-4-6',
    'gpt-oss-120b-medium',
  ],
  'custom': [
    'default',
  ],
};

export function getAcpPresetModels(preset: AcpAgentPreset): string[] {
  return [...(ACP_PRESET_MODELS[preset] ?? ['default'])];
}

async function readCodexLocalConfigModel(): Promise<string | null> {
  if (!Platform.isDesktop) throw new Error('Desktop only');
  try {
    const proc = (typeof window !== 'undefined'
      ? (window as unknown as { process?: { env?: Record<string, string | undefined> } }).process
      : undefined);
    const home = proc?.env?.HOME || proc?.env?.USERPROFILE || '';
    if (!home) return null;
    const configPath = `${home}/.codex/config.toml`;
    const fs = requireDesktopNodeModule<typeof import('node:fs')>('node:fs');
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf8');
      const match = content.match(/^model\s*=\s*"([^"]+)"/m);
      if (match && match[1]) {
        return match[1];
      }
    }
  } catch {
    // Ignore read errors
  }
  return null;
}

export interface FetchAcpModelsOptions {
  acpAgentPreset?: AcpAgentPreset;
  acpTransport?: string;
  baseUrl?: string;
  openAICodexModels?: Array<{ slug: string }>;
}

export async function fetchAcpModels(settings: FetchAcpModelsOptions): Promise<string[]> {
  const preset = settings.acpAgentPreset ?? 'claude-code';
  const models = getAcpPresetModels(preset);

  if (preset === 'codex') {
    if (settings.openAICodexModels && settings.openAICodexModels.length > 0) {
      for (const entry of settings.openAICodexModels) {
        if (entry.slug && !models.includes(entry.slug)) {
          models.push(entry.slug);
        }
      }
    }
    if (Platform.isDesktop) {
      try {
        const localModel = await readCodexLocalConfigModel();
        if (localModel && !models.includes(localModel)) {
          models.splice(1, 0, localModel);
        }
      } catch {
        // Safe ignore
      }
    }
    return models;
  }

  if (preset === 'custom' && settings.acpTransport === 'http' && settings.baseUrl) {
    try {
      const { requestUrl } = await import('obsidian');
      const res = await requestUrl({
        url: `${settings.baseUrl.replace(/\/+$/, '')}/models`,
        method: 'GET',
        throw: false,
      });
      if (res.status >= 200 && res.status < 300) {
        const data = res.json as { data?: Array<{ id: string }> };
        const fetched = data?.data?.map((m) => m.id).filter(Boolean);
        if (fetched && fetched.length > 0) {
          return fetched;
        }
      }
    } catch {
      // Fallback
    }
  }

  return models;
}
