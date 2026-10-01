/**
 * 提供商预设与设置的加载/迁移/落盘转换（纯函数，不依赖 obsidian API，可单测）。
 * 迁移链：M1-M3 扁平结构（preset/baseURL/apiKey/model/thinkingLevel/pricing）
 * → M4 多提供商结构（providers[] + activeProviderId，每家独立密钥）。
 */
import { decryptApiKey, encryptApiKey } from './storage/secureStore';
import type { CheckScope, CheckStrength, ExSettings, ProviderConfig, ThinkingLevel } from './types';

export interface ProviderPreset {
	name: string;
	baseURL: string;
	model: string;
	thinkingLevel: ThinkingLevel;
	hint?: string;
}

/** 「添加提供商」的预设模板。模型名核对于 2026-10：
 *  DeepSeek V4.1 Flash（deepseek-flash；deepseek-v4-pro 已于 2026-09-14 下线）、
 *  GLM-5.3（旗舰；glm-5.3-flash 为轻量版）、gpt-5。 */
export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
	deepseek: {
		name: 'DeepSeek',
		baseURL: 'https://api.deepseek.com/v1',
		model: 'deepseek-flash',
		thinkingLevel: 'auto',
		hint: 'deepseek-flash 即 V4.1 Flash；添加后可用「获取模型列表」查看可用型号',
	},
	glm: {
		name: '智谱 GLM',
		baseURL: 'https://open.bigmodel.cn/api/paas/v4',
		model: 'glm-5.3',
		thinkingLevel: 'off',
	},
	openai: {
		name: 'OpenAI',
		baseURL: 'https://api.openai.com/v1',
		model: 'gpt-5',
		thinkingLevel: 'auto',
	},
	custom: {
		name: '自定义',
		baseURL: '',
		model: '',
		thinkingLevel: 'auto',
		hint: '任意 OpenAI 兼容服务（Kimi、月之暗面、Ollama、OneAPI 等），填入 baseURL（通常以 /v1 结尾）',
	},
};

export function newProviderId(): string {
	const c = typeof window === 'undefined' ? undefined : window.crypto;
	if (c && typeof c.randomUUID === 'function') {
		try {
			return c.randomUUID();
		} catch {
			/* 极端环境 randomUUID 抛错：走时间戳+随机数兜底 */
		}
	}
	return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 从预设创建一个新提供商（密钥留空，由用户填写） */
export function createProvider(presetKey: string): ProviderConfig {
	const preset = PROVIDER_PRESETS[presetKey] ?? PROVIDER_PRESETS.custom;
	if (!preset) throw new Error('presets 初始化异常');
	return {
		id: newProviderId(),
		name: preset.name,
		baseURL: preset.baseURL,
		apiKey: '',
		model: preset.model,
		thinkingLevel: preset.thinkingLevel,
	};
}

const MIGRATION_PRESET_NAMES: Record<string, string> = {
	deepseek: 'DeepSeek',
	glm: '智谱 GLM',
	openai: 'OpenAI',
};

/** 旧扁平结构的已知字段（迁移用，宽松类型） */
interface LegacySettings {
	preset?: unknown;
	baseURL?: unknown;
	apiKey?: unknown;
	model?: unknown;
	thinkingLevel?: unknown;
	checkStrength?: unknown;
	checkScope?: unknown;
	backupDir?: unknown;
	backupKeep?: unknown;
	// M2 时代的思考参数（先于 M3 合并为 thinkingLevel）
	reasoningMode?: unknown;
	reasoningEffort?: unknown;
}

function asString(v: unknown, fallback = ''): string {
	return typeof v === 'string' ? v : fallback;
}

function migrateThinkingLevel(legacy: LegacySettings): ThinkingLevel {
	if (legacy.reasoningMode === 'off') return 'off';
	if (legacy.reasoningMode === 'effort') {
		const level = legacy.reasoningEffort;
		return level === 'low' || level === 'medium' || level === 'high' || level === 'max'
			? level
			: 'medium';
	}
	const t = legacy.thinkingLevel;
	if (t === 'auto' || t === 'off' || t === 'low' || t === 'medium' || t === 'high' || t === 'max') {
		return t;
	}
	return 'auto';
}

function defaultCheckStrength(v: unknown): CheckStrength {
	return v === 'light' || v === 'deep' ? v : 'standard';
}

function defaultCheckScope(v: unknown): CheckScope {
	return v === 'paragraph' || v === 'full' ? v : 'selection';
}

/**
 * 迁移旧扁平设置为多提供商结构：旧 preset/baseURL/apiKey/model/thinkingLevel
 * 折叠成一个提供商条目并设为当前使用；pricing 丢弃（计费已移除）。
 * 输入已是新格式时原样返回（浅校验），返回 null 表示无需迁移。
 */
export function migrateSettings(stored: unknown): ExSettings | null {
	if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null;
	const legacy = stored as LegacySettings & { providers?: unknown };
	if (Array.isArray(legacy.providers)) return null; // 已是新格式

	const presetKey = asString(legacy.preset, 'custom') || 'custom';
	const presetName = MIGRATION_PRESET_NAMES[presetKey];
	const provider: ProviderConfig = {
		id: newProviderId(),
		name: presetName ?? (presetKey === 'custom' ? '自定义' : presetKey),
		baseURL: asString(legacy.baseURL),
		apiKey: asString(legacy.apiKey),
		model: asString(legacy.model),
		thinkingLevel: migrateThinkingLevel(legacy),
	};
	return {
		providers: [provider],
		activeProviderId: provider.id,
		checkStrength: defaultCheckStrength(legacy.checkStrength),
		checkScope: defaultCheckScope(legacy.checkScope),
		backupDir: asString(legacy.backupDir, '.exeditor/backups') || '.exeditor/backups',
		backupKeep:
			typeof legacy.backupKeep === 'number' && legacy.backupKeep > 0 ? legacy.backupKeep : 20,
	};
}

/** 从 data.json 读出的原始数据 → 内存态设置。附带解密密钥；解密失败的密钥置空并计数 */
export function loadSettingsState(stored: unknown, defaults: ExSettings): {
	settings: ExSettings;
	decryptFailed: number;
} {
	let base: ExSettings;
	const migrated = migrateSettings(stored);
	if (migrated) {
		base = migrated;
	} else if (stored && typeof stored === 'object' && Array.isArray((stored as ExSettings).providers)) {
		const s = stored as ExSettings;
		base = { ...defaults, ...s };
	} else {
		return { settings: defaults, decryptFailed: 0 };
	}

	// 兜底：提供商列表损坏为空时重置为默认（保证恒有 ≥1 个可用的当前提供商）
	if (!base.providers.length) {
		return { settings: { ...defaults }, decryptFailed: 0 };
	}
	let decryptFailed = 0;
	const providers = base.providers.map((p) => {
		const decrypted = decryptApiKey(typeof p.apiKey === 'string' ? p.apiKey : '');
		if (decrypted === null) decryptFailed++;
		return { ...p, apiKey: decrypted ?? '' };
	});
	if (!providers.some((p) => p.id === base.activeProviderId)) {
		base.activeProviderId = providers[0]?.id ?? '';
	}
	return { settings: { ...base, providers }, decryptFailed };
}

/** 内存态设置 → 可直接写入 data.json 的形态（密钥加密为 enc: 前缀密文） */
export function encryptSettingsForSave(settings: ExSettings): ExSettings {
	return {
		...settings,
		providers: settings.providers.map((p) => ({ ...p, apiKey: encryptApiKey(p.apiKey) })),
	};
}

/** 当前生效的提供商；activeProviderId 失效时回落到第一个 */
export function getActiveProvider(settings: ExSettings): ProviderConfig {
	return (
		settings.providers.find((p) => p.id === settings.activeProviderId) ??
		settings.providers[0] ??
		createProvider('custom')
	);
}
