import { Notice, PluginSettingTab, Setting } from 'obsidian';
import type { App } from 'obsidian';
import type ExEditorPlugin from './main';
import { testConnection } from './llm/client';
import { getPricing } from './llm/pricing';
import type { ExSettings } from './types';

interface Preset {
	name: string;
	baseURL: string;
	model: string;
	thinkingLevel: ExSettings['thinkingLevel'];
	hint?: string;
}

/** 提供商预设：DeepSeek / GLM / 自定义（Kimi/OpenAI/Ollama 等 M5 补全）。
 *  deepseek-chat/reasoner 已于 2026-07 停用，官方模型为 deepseek-flash / deepseek-v4-pro。 */
export const PRESETS: Record<string, Preset> = {
	deepseek: {
		name: 'DeepSeek',
		baseURL: 'https://api.deepseek.com/v1',
		model: 'deepseek-flash',
		thinkingLevel: 'auto',
		hint: '推理更强可改用 deepseek-v4-pro，或在下方调高思考深度',
	},
	glm: {
		name: '智谱 GLM',
		baseURL: 'https://open.bigmodel.cn/api/paas/v4',
		model: 'glm-4.6',
		thinkingLevel: 'off',
	},
	custom: {
		name: '自定义（任意 OpenAI 兼容服务）',
		baseURL: '',
		model: '',
		thinkingLevel: 'auto',
		hint: '填入服务商的 baseURL（通常以 /v1 结尾）与模型名',
	},
};

export const DEFAULT_SETTINGS: ExSettings = {
	preset: 'deepseek',
	baseURL: PRESETS.deepseek?.baseURL ?? '',
	apiKey: '',
	model: PRESETS.deepseek?.model ?? '',
	thinkingLevel: 'auto',
	checkStrength: 'standard',
	pricing: {},
	backupDir: '.exeditor/backups',
	backupKeep: 20,
};

export class ExSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: ExEditorPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;

		new Setting(containerEl).setName('模型服务').setHeading();

		new Setting(containerEl)
			.setName('服务预设')
			.setDesc('选择常用服务商自动填入地址与模型，之后可自由修改')
			.addDropdown((drop) => {
				for (const [key, preset] of Object.entries(PRESETS)) {
					drop.addOption(key, preset.name);
				}
			drop.setValue(s.preset).onChange(async (value) => {
				s.preset = value;
				const preset = PRESETS[value];
				if (preset) {
					s.baseURL = preset.baseURL;
					s.model = preset.model;
					s.thinkingLevel = preset.thinkingLevel;
				}
				await this.plugin.saveSettings();
				this.display();
			});
			});
		const preset = PRESETS[s.preset];
		if (preset?.hint) {
			containerEl.createDiv({
				cls: 'setting-item-description ex-setting-hint',
				text: `提示：${preset.hint}`,
			});
		}

		new Setting(containerEl)
			.setName('API 地址')
			.setDesc('OpenAI 兼容服务地址，通常以 /v1 结尾')
			.addText((text) =>
				text
					.setPlaceholder('填写服务商的 API 地址')
					.setValue(s.baseURL)
					.onChange(async (value) => {
						s.baseURL = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		const apiKeySetting = new Setting(containerEl).setName('API 密钥').addText((text) => {
			text.inputEl.type = 'password';
			text.setPlaceholder('形如 sk-…').setValue(s.apiKey).onChange(async (value) => {
				s.apiKey = value.trim();
				await this.plugin.saveSettings();
			});
		});
		apiKeySetting.descEl.setText(
			s.apiKey ? `已配置（尾号 ${s.apiKey.slice(-4)}），只保存在本机 data.json` : '服务商控制台获取，只保存在本机 data.json',
		);

		new Setting(containerEl).setName('模型名').addText((text) =>
			text
				.setPlaceholder('如 deepseek-flash')
				.setValue(s.model)
				.onChange(async (value) => {
					s.model = value.trim();
					await this.plugin.saveSettings();
				}),
		);

		new Setting(containerEl).setName('思考深度').setHeading();

		new Setting(containerEl)
			.setName('深度')
			.setDesc(
				'不同服务商支持的档位不同（DeepSeek/GLM：low/high/max；OpenAI：low/medium/high），不支持的档位可能报错，按预设选即可。思考过程与用量显示在侧边栏底部',
			)
			.addDropdown((drop) =>
				drop
					.addOption('auto', '跟随服务商默认（不发送参数）')
					.addOption('off', '关闭（thinking: disabled）')
					.addOption('low', '浅（reasoning_effort: low）')
					.addOption('medium', '中（reasoning_effort: medium）')
					.addOption('high', '深（reasoning_effort: high）')
					.addOption('max', '极致（reasoning_effort: max）')
					.setValue(s.thinkingLevel)
					.onChange(async (value) => {
						s.thinkingLevel = value as ExSettings['thinkingLevel'];
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName('计费').setHeading();

		if (!s.model) {
			containerEl.createDiv({
				cls: 'setting-item-description ex-setting-hint',
				text: '先填写模型名，再配置价格',
			});
		} else {
			const builtin = getPricing(s, s.model);
			const custom = s.pricing[s.model];
			let inVal = custom ? String(custom.input) : '';
			let outVal = custom ? String(custom.output) : '';
			const save = async (): Promise<void> => {
				const i = parseFloat(inVal);
				const o = parseFloat(outVal);
				const ok = (v: number): boolean => Number.isFinite(v) && v >= 0;
				if (inVal.trim() === '' && outVal.trim() === '') {
					delete s.pricing[s.model];
				} else if (ok(i) && ok(o)) {
					s.pricing[s.model] = { input: i, output: o };
				} else {
					return; // 只填了一项或数值非法：暂不保存
				}
				await this.plugin.saveSettings();
			};
			new Setting(containerEl)
				.setName(`「${s.model}」价格`)
				.setDesc(
					builtin
						? `元 / 百万 tokens。内置官方价：输入 ¥${builtin.input} / 输出 ¥${builtin.output}（2026-09 核对，DeepSeek 取高峰价）；填写后覆盖`
						: '元 / 百万 tokens。该模型无内置价格（如 glm-4.6 已从官方价目表下架），两项都填写后侧边栏显示费用估算',
				)
				.addText((text) =>
					text
						.setPlaceholder('输入价')
						.setValue(inVal)
						.onChange(async (v) => {
							inVal = v.trim();
							await save();
						}),
				)
				.addText((text) =>
					text
						.setPlaceholder('输出价')
						.setValue(outVal)
						.onChange(async (v) => {
							outVal = v.trim();
							await save();
						}),
				);
		}

		new Setting(containerEl).setName('测试连接').addButton((button) => {
			button.setButtonText('发送一条测试消息').onClick(async () => {
				button.setDisabled(true);
				button.setButtonText('测试中…');
				try {
					const reply = await testConnection(this.plugin.settings);
					new Notice(`连接成功，模型回复「${reply}」`);
				} catch (e) {
					new Notice(`连接失败 — ${e instanceof Error ? e.message : String(e)}`, 8000);
				} finally {
					button.setDisabled(false);
					button.setButtonText('发送一条测试消息');
				}
			});
		});
		new Setting(containerEl).setName('备份').setHeading();

		new Setting(containerEl)
			.setName('备份目录')
			.setDesc('vault 内路径；快照目录镜像笔记的目录结构，避免同名笔记冲突')
			.addText((text) =>
				text
					.setPlaceholder('.exeditor/backups')
					.setValue(s.backupDir)
					.onChange(async (value) => {
						s.backupDir = value.trim() || '.exeditor/backups';
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('每篇保留份数')
			.setDesc('超出后自动删除最旧的快照')
			.addText((text) =>
				text
					.setValue(String(s.backupKeep))
					.onChange(async (value) => {
						const n = parseInt(value, 10);
						if (Number.isFinite(n) && n > 0) {
							s.backupKeep = n;
							await this.plugin.saveSettings();
						}
					}),
			);
	}
}
