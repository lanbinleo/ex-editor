import { Notice, PluginSettingTab, Setting } from 'obsidian';
import type { App } from 'obsidian';
import type ExEditorPlugin from './main';
import { testConnection } from './llm/client';
import type { ExSettings } from './types';

interface Preset {
	name: string;
	baseURL: string;
	model: string;
	reasoningMode: ExSettings['reasoningMode'];
	hint?: string;
}

/** M2 提供商预设：DeepSeek / GLM / 自定义（Kimi/OpenAI/Ollama 等 M5 补全）。
 *  deepseek-chat/reasoner 已于 2026-07 停用，官方模型为 deepseek-flash / deepseek-v4-pro。 */
export const PRESETS: Record<string, Preset> = {
	deepseek: {
		name: 'DeepSeek',
		baseURL: 'https://api.deepseek.com/v1',
		model: 'deepseek-flash',
		reasoningMode: 'auto',
		hint: '推理更强可改用 deepseek-v4-pro，或在下方开启思维链',
	},
	glm: {
		name: '智谱 GLM',
		baseURL: 'https://open.bigmodel.cn/api/paas/v4',
		model: 'glm-4.6',
		reasoningMode: 'off',
	},
	custom: {
		name: '自定义（任意 OpenAI 兼容服务）',
		baseURL: '',
		model: '',
		reasoningMode: 'auto',
		hint: '填入服务商的 baseURL（通常以 /v1 结尾）与模型名',
	},
};

export const DEFAULT_SETTINGS: ExSettings = {
	preset: 'deepseek',
	baseURL: PRESETS.deepseek?.baseURL ?? '',
	apiKey: '',
	model: PRESETS.deepseek?.model ?? '',
	reasoningMode: 'auto',
	reasoningEffort: 'medium',
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
					s.reasoningMode = preset.reasoningMode;
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

		new Setting(containerEl).setName('思维链').setHeading();

		new Setting(containerEl)
			.setName('思考模式')
			.setDesc('开启后模型先深度思考再作答，质量更高但更慢；思考过程与用量显示在侧边栏底部')
			.addDropdown((drop) =>
				drop
					.addOption('auto', '跟随服务商默认（不发送参数）')
					.addOption('on', '开启（thinking: enabled）')
					.addOption('off', '关闭（thinking: disabled）')
					.addOption('effort', '按力度（reasoning_effort）')
					.setValue(s.reasoningMode)
					.onChange(async (value) => {
						s.reasoningMode = value as ExSettings['reasoningMode'];
						await this.plugin.saveSettings();
						this.display();
					}),
			);

		if (s.reasoningMode === 'effort') {
			new Setting(containerEl).setName('思考力度').addDropdown((drop) =>
				drop
					.addOption('low', '低')
					.addOption('medium', '中')
					.addOption('high', '高')
					.setValue(s.reasoningEffort)
					.onChange(async (value) => {
						s.reasoningEffort = value as ExSettings['reasoningEffort'];
						await this.plugin.saveSettings();
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
	}
}
