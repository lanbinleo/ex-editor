import { Notice, Plugin } from 'obsidian';
import type { Editor, Menu } from 'obsidian';
import { EditorView } from '@codemirror/view';
import { EditorContextResolver } from './editorContext';
import { CheckController } from './controller/checkController';
import type { CheckScope } from './controller/checkController';
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
			callback: () => void this.runCheck('paragraph'),
		});
		this.addCommand({
			id: 'check-selection',
			name: '检查选中文字',
			callback: () => void this.runCheck('selection'),
		});
		this.addCommand({
			id: 'check-full',
			name: '检查全文',
			callback: () => void this.runCheck('full'),
		});
		this.addCommand({
			id: 'cancel-check',
			name: '取消所有进行中的检查',
			callback: () => this.checker.cancelAll(),
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
		// 选区/文档变化 → 侧边栏范围预览实时刷新（节流在 resolver 内）；
		// 文档被编辑 → 防抖重校验建议，原文找不到的灰显（stale）
		this.registerEditorExtension(
			EditorView.updateListener.of((update) => {
				if (update.docChanged) this.suggestions.scheduleRevalidate();
				if (update.selectionSet || update.docChanged) this.resolver.noteEditorActivity();
			}),
		);
		this.registerEvent(
			this.app.workspace.on('editor-menu', (menu: Menu, editor: Editor) => {
				const hasSelection = editor.listSelections().some((s) => s.anchor !== s.head);
				menu.addItem((item) =>
					item
						.setTitle(hasSelection ? '检查选中文字' : '检查本段落')
						.setIcon('spell-check')
						.onClick(() => void this.runCheck(hasSelection ? 'selection' : 'paragraph')),
				);
			}),
		);

		this.addSettingTab(new ExSettingTab(this.app, this));
	}

	onunload(): void {
		// 不 detach 侧边栏 leaf：插件重载（含热重载）时保留用户放置的面板位置
	}

	async loadSettings(): Promise<void> {
		const stored = (await this.loadData()) as Partial<ExSettings> | null;
		const merged: ExSettings = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
		// M2→M3 迁移：reasoningMode + reasoningEffort 合并为 thinkingLevel
		const legacy = stored as unknown as { reasoningMode?: string; reasoningEffort?: string } | null;
		if (legacy?.reasoningMode) {
			if (legacy.reasoningMode === 'off') merged.thinkingLevel = 'off';
			else if (legacy.reasoningMode === 'effort') {
				const level = legacy.reasoningEffort;
				merged.thinkingLevel =
					level === 'low' || level === 'medium' || level === 'high' || level === 'max'
						? level
						: 'medium';
			} else merged.thinkingLevel = 'auto';
		}
		this.settings = merged;
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/** 运行指定范围的检查；有建议时自动展示侧边栏 */
	async runCheck(scope: CheckScope): Promise<void> {
		const added = await this.checker.run(scope);
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
