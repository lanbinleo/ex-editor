import { Menu, Notice, PluginSettingTab, Setting } from 'obsidian';
import type { App } from 'obsidian';
import type ExEditorPlugin from './main';
import { listModels, testConnection } from './llm/client';
import { createProvider, getActiveProvider, PROVIDER_PRESETS } from './providers';
import { isEncryptionAvailable } from './storage/secureStore';
import type { ExSettings, ThinkingLevel } from './types';

const defaultProvider = createProvider('deepseek');

export const DEFAULT_SETTINGS: ExSettings = {
	providers: [defaultProvider],
	activeProviderId: defaultProvider.id,
	checkStrength: 'standard',
	checkScope: 'selection',
	backupDir: '.exeditor/backups',
	backupKeep: 20,
};

/** 密钥存储状态描述（加密与否取决于本机是否可用 safeStorage） */
function keyStorageDesc(active: { apiKey: string }): string {
	const encrypted = isEncryptionAvailable();
	if (active.apiKey) {
		return `已配置（尾号 ${active.apiKey.slice(-4)}），${
			encrypted ? '加密保存在本机 data.json' : '明文保存在本机 data.json（本设备不支持加密）'
		}`;
	}
	return `服务商控制台获取，${encrypted ? '加密' : '明文'}保存在本机 data.json（已排除出 Git）`;
}

export class ExSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: ExEditorPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;
		const active = getActiveProvider(s);

		new Setting(containerEl).setName('模型服务').setHeading();

		new Setting(containerEl)
			.setName('当前提供商')
			.setDesc('检查与改写都使用当前提供商的地址、密钥与模型；每家提供商独立保存密钥')
			.addDropdown((drop) => {
				for (const p of s.providers) drop.addOption(p.id, p.name || '未命名');
				drop.setValue(active.id).onChange(async (id) => {
					s.activeProviderId = id;
					await this.plugin.saveSettings();
					this.display();
				});
			});

		new Setting(containerEl)
			.setName('名称')
			.setDesc('仅用于显示')
			.addText((text) =>
				text
					.setPlaceholder('如 DeepSeek')
					.setValue(active.name)
					.onChange(async (value) => {
						active.name = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('API 地址')
			.setDesc('OpenAI 兼容服务地址，通常以 /v1 结尾')
			.addText((text) =>
				text
					.setPlaceholder('填写服务商的 API 地址')
					.setValue(active.baseURL)
					.onChange(async (value) => {
						active.baseURL = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		const apiKeySetting = new Setting(containerEl).setName('API 密钥').addText((text) => {
			text.inputEl.type = 'password';
			text.setPlaceholder('形如 sk-…').setValue(active.apiKey).onChange(async (value) => {
				active.apiKey = value.trim();
				await this.plugin.saveSettings();
				apiKeySetting.descEl.setText(keyStorageDesc(active));
			});
		});
		apiKeySetting.descEl.setText(keyStorageDesc(active));

		const modelSetting = new Setting(containerEl)
			.setName('模型')
			.setDesc('手动输入，或「获取列表」后从服务商的 /models 中选择');
		modelSetting.addText((text) =>
			text
				.setPlaceholder('如 deepseek-flash')
				.setValue(active.model)
				.onChange(async (value) => {
					active.model = value.trim();
					await this.plugin.saveSettings();
				}),
		);
		if (active.models?.length) {
			modelSetting.addButton((button) =>
				button.setButtonText('选择').onClick((evt) => {
					const menu = new Menu();
					for (const model of active.models ?? []) {
						menu.addItem((item) =>
							item.setTitle(model).onClick(async () => {
								active.model = model;
								await this.plugin.saveSettings();
								this.display();
							}),
						);
					}
					menu.showAtMouseEvent(evt);
				}),
			);
		}
		modelSetting.addButton((button) => {
			button.setButtonText('获取列表').onClick(async () => {
				button.setDisabled(true);
				button.setButtonText('获取中…');
				try {
					const models = await listModels(active);
					active.models = models;
					if (!active.model && models[0]) active.model = models[0];
					await this.plugin.saveSettings();
					new Notice(`获取到 ${models.length} 个模型，可点「选择」挑选`);
				} catch (e) {
					new Notice(`获取模型列表失败 — ${e instanceof Error ? e.message : String(e)}`, 8000);
				} finally {
					this.display();
				}
			});
		});

		new Setting(containerEl)
			.setName('思考深度')
			.setDesc(
				'不同服务商支持的档位不同（DeepSeek/GLM：low/high/max；OpenAI：low/medium/high），不支持的档位可能报错。思考过程与用量显示在侧边栏底部',
			)
			.addDropdown((drop) =>
				drop
					.addOption('auto', '跟随服务商默认（不发送参数）')
					.addOption('off', '关闭（thinking: disabled）')
					.addOption('low', '浅（reasoning_effort: low）')
					.addOption('medium', '中（reasoning_effort: medium）')
					.addOption('high', '深（reasoning_effort: high）')
					.addOption('max', '极致（reasoning_effort: max）')
					.setValue(active.thinkingLevel)
					.onChange(async (value) => {
						active.thinkingLevel = value as ThinkingLevel;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName('测试连接').addButton((button) => {
			button.setButtonText('发送一条测试消息').onClick(async () => {
				button.setDisabled(true);
				button.setButtonText('测试中…');
				try {
					const reply = await testConnection(active);
					new Notice(`连接成功，模型回复「${reply}」`);
				} catch (e) {
					new Notice(`连接失败 — ${e instanceof Error ? e.message : String(e)}`, 8000);
				} finally {
					button.setDisabled(false);
					button.setButtonText('发送一条测试消息');
				}
			});
		});

		new Setting(containerEl).setName('提供商管理').setHeading();

		for (const p of s.providers) {
			const desc = p.id === s.activeProviderId ? `${p.baseURL || '未配置地址'} · 使用中` : p.baseURL || '未配置地址';
			new Setting(containerEl)
				.setName(p.name || '未命名')
				.setDesc(desc)
				.addButton((button) =>
					button
						.setButtonText('删除')
						.setDisabled(s.providers.length <= 1)
						.onClick(async () => {
							if (s.providers.length <= 1) return;
							s.providers = s.providers.filter((x) => x.id !== p.id);
							if (s.activeProviderId === p.id) {
								s.activeProviderId = s.providers[0]?.id ?? '';
							}
							await this.plugin.saveSettings();
							this.display();
						}),
				);
		}

		new Setting(containerEl)
			.setName('添加提供商')
			.setDesc('从预设创建（添加后可自由修改），或添加自定义 OpenAI 兼容服务')
			.addButton((button) =>
				button.setButtonText('添加…').onClick((evt) => {
					const menu = new Menu();
					for (const [key, preset] of Object.entries(PROVIDER_PRESETS)) {
						menu.addItem((item) =>
							item.setTitle(preset.name).onClick(async () => {
								const created = createProvider(key);
								s.providers.push(created);
								// 添加后立即切换为当前，方便接着填写密钥
								s.activeProviderId = created.id;
								await this.plugin.saveSettings();
								this.display();
							}),
						);
					}
					menu.showAtMouseEvent(evt);
				}),
			);

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
