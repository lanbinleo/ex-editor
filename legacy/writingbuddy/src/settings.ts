import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type EditingSuggestionsPlugin from '../main';
import { testConnection } from './llm/client';
import type { WBSettings } from './types';

interface Preset {
  name: string;
  baseURL: string;
  model: string;
  reasoningMode: WBSettings['reasoningMode'];
  reasoningEffort: WBSettings['reasoningEffort'];
  hint?: string;
}

export const PRESETS: Record<string, Preset> = {
  deepseek: {
    name: 'DeepSeek',
    baseURL: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    reasoningMode: 'none',
    reasoningEffort: 'medium',
    hint: '想要思维链深度分析可把模型改为 deepseek-reasoner',
  },
  glm: {
    name: '智谱 GLM',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4.6',
    reasoningMode: 'thinking',
    reasoningEffort: 'medium',
  },
  kimi: {
    name: 'Kimi（月之暗面）',
    baseURL: 'https://api.moonshot.cn/v1',
    model: 'kimi-k2',
    reasoningMode: 'none',
    reasoningEffort: 'medium',
  },
  openai: {
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    reasoningMode: 'effort',
    reasoningEffort: 'medium',
  },
  ollama: {
    name: 'Ollama（本地）',
    baseURL: 'http://localhost:11434/v1',
    model: 'qwen3',
    reasoningMode: 'none',
    reasoningEffort: 'medium',
    hint: '本地部署无需 API Key，密钥可随便填一个',
  },
  custom: {
    name: '自定义（任意 OpenAI 兼容服务）',
    baseURL: '',
    model: '',
    reasoningMode: 'none',
    reasoningEffort: 'medium',
  },
};

export class EditingSuggestionsSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: EditingSuggestionsPlugin) {
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
            s.reasoningEffort = preset.reasoningEffort;
          }
          await this.plugin.saveSettings();
          this.display();
        });
      });
    const preset = PRESETS[s.preset];
    if (preset?.hint) {
      containerEl.createEl('div', {
        cls: 'setting-item-description es-setting-hint',
        text: `提示：${preset.hint}`,
      });
    }

    new Setting(containerEl).setName('API 地址 (baseURL)').addText((text) =>
      text
        .setPlaceholder('https://api.deepseek.com/v1')
        .setValue(s.baseURL)
        .onChange(async (value) => {
          s.baseURL = value.trim();
          await this.plugin.saveSettings();
        }),
    );

    const apiKeySetting = new Setting(containerEl).setName('API Key').addText((text) => {
      text.inputEl.type = 'password';
      text.setPlaceholder('sk-…').setValue(s.apiKey).onChange(async (value) => {
        s.apiKey = value.trim();
        await this.plugin.saveSettings();
      });
    });
    apiKeySetting.descEl.setText(
      s.apiKey ? `已配置（尾号 ${s.apiKey.slice(-4)}）` : '服务商控制台获取',
    );

    new Setting(containerEl).setName('模型名').addText((text) =>
      text
        .setPlaceholder('deepseek-chat')
        .setValue(s.model)
        .onChange(async (value) => {
          s.model = value.trim();
          await this.plugin.saveSettings();
        }),
    );

    new Setting(containerEl).setName('测试连接').addButton((button) => {
      button.setButtonText('发送一条测试消息').onClick(async () => {
        button.setDisabled(true);
        button.setButtonText('测试中…');
        try {
          const reply = await testConnection(this.plugin.settings);
          new Notice(`编辑建议：连接成功，模型回复「${reply}」`);
        } catch (e) {
          new Notice(`编辑建议：连接失败 — ${e instanceof Error ? e.message : String(e)}`, 8000);
        } finally {
          button.setDisabled(false);
          button.setButtonText('发送一条测试消息');
        }
      });
    });

    new Setting(containerEl).setName('生成参数').setHeading();

    new Setting(containerEl)
      .setName('思维链参数')
      .setDesc('让模型在输出前深度思考。不同服务商支持的参数不同，按预设填好即可')
      .addDropdown((drop) =>
        drop
          .addOption('none', '不发送')
          .addOption('thinking', 'thinking 参数（GLM 等）')
          .addOption('effort', 'reasoning_effort 参数（OpenAI 等）')
          .setValue(s.reasoningMode)
          .onChange(async (value) => {
            s.reasoningMode = value as WBSettings['reasoningMode'];
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
            s.reasoningEffort = value as WBSettings['reasoningEffort'];
            await this.plugin.saveSettings();
          }),
      );
    }

    new Setting(containerEl)
      .setName('最大输出 Token')
      .setDesc('长文检查建议调大（如 16384）；提示被截断时增大此值')
      .addText((text) =>
        text
          .setValue(String(s.maxTokens))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (Number.isFinite(n) && n > 0) {
              s.maxTokens = n;
              await this.plugin.saveSettings();
            }
          }),
      );

    new Setting(containerEl)
      .setName('请求超时（秒）')
      .setDesc('思维链模式推理较慢，默认 300 秒')
      .addText((text) =>
        text.setValue(String(s.requestTimeoutSec)).onChange(async (value) => {
          const n = parseInt(value, 10);
          if (Number.isFinite(n) && n >= 5) {
            s.requestTimeoutSec = n;
            await this.plugin.saveSettings();
          }
        }),
      );

    new Setting(containerEl)
      .setName('强制 JSON 输出 (response_format)')
      .setDesc('部分服务商不支持时插件会自动去掉该参数重试')
      .addToggle((toggle) =>
        toggle.setValue(s.useJsonMode).onChange(async (value) => {
          s.useJsonMode = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('使用 requestUrl')
      .setDesc('默认开启以绕过 CORS；个别服务兼容性差时关闭改用 fetch')
      .addToggle((toggle) =>
        toggle.setValue(s.useRequestUrl).onChange(async (value) => {
          s.useRequestUrl = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('附加请求参数 (JSON)')
      .setDesc('高级用法：浅合并进请求体，例如供应商特殊开关')
      .addTextArea((area) =>
        area
          .setPlaceholder('{"top_p": 0.9}')
          .setValue(s.extraBody)
          .onChange(async (value) => {
            s.extraBody = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl).setName('校对').setHeading();

    new Setting(containerEl)
      .setName('长文提示阈值（字数）')
      .setDesc('全文超过该字数仍会单次请求全文检查，但会先提示你确认')
      .addText((text) =>
        text.setValue(String(s.longDocThreshold)).onChange(async (value) => {
          const n = parseInt(value, 10);
          if (Number.isFinite(n) && n >= 1000) {
            s.longDocThreshold = n;
            await this.plugin.saveSettings();
          }
        }),
      );

    new Setting(containerEl).setName('备份').setHeading();

    new Setting(containerEl)
      .setName('备份目录')
      .setDesc('vault 内路径；每篇笔记一个子目录，存放纯文本 .md 快照')
      .addText((text) =>
        text.setValue(s.backupDir).onChange(async (value) => {
          s.backupDir = value.trim() || '.writing-buddy/backups';
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('每篇保留份数')
      .addText((text) =>
        text.setValue(String(s.backupKeep)).onChange(async (value) => {
          const n = parseInt(value, 10);
          if (Number.isFinite(n) && n > 0) {
            s.backupKeep = n;
            await this.plugin.saveSettings();
          }
        }),
      );

    new Setting(containerEl)
      .setName('每次检查完成后自动备份')
      .setDesc('批量接受修改与重写应用前始终会自动备份，不受此开关影响')
      .addToggle((toggle) =>
        toggle.setValue(s.backupOnCheck).onChange(async (value) => {
          s.backupOnCheck = value;
          await this.plugin.saveSettings();
        }),
      );
  }
}
