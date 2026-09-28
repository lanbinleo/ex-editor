import { Notice, Plugin } from 'obsidian';
import { EditorContextResolver } from './editorContext';
import { CheckController } from './controller/checkController';
import { SuggestionController } from './controller/suggestionController';
import { ExSettingTab, DEFAULT_SETTINGS } from './settings';
import { ExSidebarView, VIEW_TYPE_EX_SIDEBAR } from './view/sidebar';
import type { ExSettings } from './types';

/**
 * 插件入口：只管生命周期与注册。
 * 检查编排 → CheckController；建议管理 → SuggestionController；界面只消费状态。
 */
export default class ExEditorPlugin extends Plugin {
	settings!: ExSettings;
	resolver!: EditorContextResolver;
	suggestions!: SuggestionController;
	checker!: CheckController;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.resolver = new EditorContextResolver(this.app);
		this.suggestions = new SuggestionController(this.resolver);
		this.checker = new CheckController(this);

		this.registerView(VIEW_TYPE_EX_SIDEBAR, (leaf) => new ExSidebarView(leaf, this));

		this.addRibbonIcon('spell-check', '打开校对面板', () => void this.activateSidebar());
		this.addCommand({
			id: 'open-sidebar',
			name: '打开校对面板',
			callback: () => void this.activateSidebar(),
		});
		this.addCommand({
			id: 'check-paragraph',
			name: '检查本段落',
			callback: () => void this.runParagraphCheck(),
		});
		this.addCommand({
			id: 'smoke-test',
			name: '冒烟测试：确认插件已加载',
			callback: () => {
				new Notice('插件已就绪');
			},
		});

		this.registerEvent(
			this.app.workspace.on('active-leaf-change', (leaf) => this.resolver.noteActiveLeaf(leaf)),
		);
		this.registerEvent(
			this.app.workspace.on('file-open', (file) => this.resolver.noteFile(file)),
		);

		this.addSettingTab(new ExSettingTab(this.app, this));
	}

	onunload(): void {
		// 不 detach 侧边栏 leaf：插件重载（含热重载）时保留用户放置的面板位置
	}

	async loadSettings(): Promise<void> {
		const stored = (await this.loadData()) as Partial<ExSettings> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/** 检查当前段落；有建议时自动展示侧边栏 */
	async runParagraphCheck(): Promise<void> {
		const added = await this.checker.checkParagraph();
		if (added > 0) await this.activateSidebar();
	}

	async activateSidebar(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_EX_SIDEBAR);
		const first = existing[0];
		if (first) {
			await this.app.workspace.revealLeaf(first);
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: VIEW_TYPE_EX_SIDEBAR, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}
}
