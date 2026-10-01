import { afterEach, describe, expect, it } from 'vitest';
import {
	createProvider,
	encryptSettingsForSave,
	getActiveProvider,
	loadSettingsState,
	migrateSettings,
} from '../src/providers';
import { setSafeStorageForTest } from '../src/storage/secureStore';
import type { ExSettings, ProviderConfig } from '../src/types';

const defaults: ExSettings = {
	providers: [createProvider('deepseek')],
	activeProviderId: '',
	checkStrength: 'standard',
	checkScope: 'selection',
	backupDir: '.exeditor/backups',
	backupKeep: 20,
};
defaults.activeProviderId = defaults.providers[0]?.id ?? '';

afterEach(() => {
	setSafeStorageForTest(null);
});

describe('migrateSettings（旧扁平 → 多提供商）', () => {
	it('M1-M3 扁平结构折叠为一个提供商并设为当前', () => {
		const migrated = migrateSettings({
			preset: 'deepseek',
			baseURL: 'https://api.deepseek.com/v1',
			apiKey: 'sk-old',
			model: 'deepseek-flash',
			thinkingLevel: 'high',
			checkStrength: 'deep',
			checkScope: 'paragraph',
			backupDir: '.exeditor/backups',
			backupKeep: 10,
			pricing: { 'deepseek-flash': { input: 2, output: 8 } },
		});
		expect(migrated).not.toBeNull();
		expect(migrated?.providers).toHaveLength(1);
		const p = migrated?.providers[0] as ProviderConfig;
		expect(p.name).toBe('DeepSeek');
		expect(p.baseURL).toBe('https://api.deepseek.com/v1');
		expect(p.apiKey).toBe('sk-old');
		expect(p.model).toBe('deepseek-flash');
		expect(p.thinkingLevel).toBe('high');
		expect(migrated?.activeProviderId).toBe(p.id);
		expect(migrated?.checkStrength).toBe('deep');
		expect(migrated?.checkScope).toBe('paragraph');
		expect(migrated?.backupKeep).toBe(10);
		// 计费数据不再保留
		expect(JSON.stringify(migrated)).not.toContain('pricing');
	});

	it('glm 预设名映射、M2 思考参数迁移', () => {
		const migrated = migrateSettings({
			preset: 'glm',
			baseURL: 'https://open.bigmodel.cn/api/paas/v4',
			apiKey: 'k',
			model: 'glm-4.6',
			reasoningMode: 'effort',
			reasoningEffort: 'max',
		});
		expect(migrated?.providers[0]?.name).toBe('智谱 GLM');
		expect(migrated?.providers[0]?.thinkingLevel).toBe('max');

		const off = migrateSettings({ preset: 'glm', reasoningMode: 'off' });
		expect(off?.providers[0]?.thinkingLevel).toBe('off');
	});

	it('custom 预设与未知 preset 的名称兜底', () => {
		expect(migrateSettings({ preset: 'custom' })?.providers[0]?.name).toBe('自定义');
		expect(migrateSettings({ preset: 'kimi' })?.providers[0]?.name).toBe('kimi');
	});

	it('已是新格式返回 null；空输入返回 null', () => {
		expect(migrateSettings({ providers: [{ ...createProvider('glm') }] })).toBeNull();
		expect(migrateSettings(null)).toBeNull();
		expect(migrateSettings('x')).toBeNull();
	});
});

describe('loadSettingsState', () => {
	it('无存量数据 → 默认设置', () => {
		const { settings, decryptFailed } = loadSettingsState(null, defaults);
		expect(decryptFailed).toBe(0);
		expect(settings.providers).toHaveLength(1);
		expect(settings.providers[0]?.name).toBe('DeepSeek');
	});

	it('新格式原样通过（含密钥明文）', () => {
		const stored: ExSettings = {
			...defaults,
			providers: [
				{ id: 'a', name: 'A', baseURL: 'u', apiKey: 'k1', model: 'm', thinkingLevel: 'auto' },
				{ id: 'b', name: 'B', baseURL: 'u2', apiKey: 'k2', model: 'm2', thinkingLevel: 'off' },
			],
			activeProviderId: 'b',
		};
		const { settings, decryptFailed } = loadSettingsState(stored, defaults);
		expect(decryptFailed).toBe(0);
		expect(settings.activeProviderId).toBe('b');
		expect(settings.providers[1]?.apiKey).toBe('k2');
	});

	it('activeProviderId 失效回落到第一个；providers 损坏为空重置默认', () => {
		const broken = { ...defaults, providers: [], activeProviderId: 'x' };
		const { settings } = loadSettingsState(broken, defaults);
		expect(settings.providers).toHaveLength(1);
	});
});

describe('密钥加密落盘（fake safeStorage 注入）', () => {
	const fake = {
		isEncryptionAvailable: () => true,
		encryptString: (s: string) => new TextEncoder().encode(`fake(${s})`),
		decryptString: (b: Uint8Array) => {
			const text = new TextDecoder().decode(b);
			if (!text.startsWith('fake(')) throw new Error('bad ciphertext');
			return text.slice(5, -1);
		},
	};

	it('保存时加密为 enc: 前缀，加载时解密还原', () => {
		setSafeStorageForTest(fake);
		const stored: ExSettings = {
			...defaults,
			providers: [
				{ id: 'a', name: 'A', baseURL: 'u', apiKey: 'sk-secret', model: 'm', thinkingLevel: 'auto' },
			],
		};
		const persisted = encryptSettingsForSave(stored);
		const savedKey = persisted.providers[0]?.apiKey ?? '';
		expect(savedKey.startsWith('enc:')).toBe(true);
		expect(savedKey).not.toContain('sk-secret');
		// 模拟下一轮加载
		const { settings, decryptFailed } = loadSettingsState(persisted, defaults);
		expect(decryptFailed).toBe(0);
		expect(settings.providers[0]?.apiKey).toBe('sk-secret');
	});

	it('密文来自其他设备（解密失败）→ 置空并计数', () => {
		setSafeStorageForTest(fake);
		const { settings, decryptFailed } = loadSettingsState(
			{ ...defaults, providers: [{ id: 'a', name: 'A', baseURL: 'u', apiKey: 'enc:bm90LWZha2U=', model: 'm', thinkingLevel: 'auto' }] },
			defaults,
		);
		expect(decryptFailed).toBe(1);
		expect(settings.providers[0]?.apiKey).toBe('');
	});

	it('无 safeStorage（移动端）：明文保存、明文读取', () => {
		setSafeStorageForTest(null);
		const persisted = encryptSettingsForSave({
			...defaults,
			providers: [{ id: 'a', name: 'A', baseURL: 'u', apiKey: 'sk-plain', model: 'm', thinkingLevel: 'auto' }],
		});
		expect(persisted.providers[0]?.apiKey).toBe('sk-plain');
		const { settings } = loadSettingsState(persisted, defaults);
		expect(settings.providers[0]?.apiKey).toBe('sk-plain');
	});
});

describe('getActiveProvider', () => {
	it('按 id 命中；失效回落第一个', () => {
		const p1 = { id: 'a', name: 'A', baseURL: 'u', apiKey: 'k', model: 'm', thinkingLevel: 'auto' as const };
		const p2 = { ...p1, id: 'b', name: 'B' };
		expect(getActiveProvider({ ...defaults, providers: [p1, p2], activeProviderId: 'b' }).name).toBe('B');
		expect(getActiveProvider({ ...defaults, providers: [p1, p2], activeProviderId: 'zzz' }).name).toBe('A');
	});
});
