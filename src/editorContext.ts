import { MarkdownView } from 'obsidian';
import type { App, Editor, TFile, WorkspaceLeaf } from 'obsidian';
import type { EditorView } from '@codemirror/view';

export interface EditorContext {
	file: TFile;
	view: EditorView;
}

/**
 * 解析「当前操作的文档」：
 * 1. 焦点在 Markdown 视图上时就是它；
 * 2. 焦点在侧边栏/设置页时，回落到最近编辑过的那篇——用户点开侧边栏后，
 *    所有动作应继续作用于原文档，而不是要求重新打开；
 * 3. 都没有时取任意打开的 Markdown 视图。
 */
export class EditorContextResolver {
	private lastMarkdownPath = '';
	private listeners = new Set<() => void>();

	constructor(private app: App) {}

	/** 活动文档变化时通知（侧边栏据此切换显示的文件） */
	subscribe(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	private emit(): void {
		for (const fn of this.listeners) fn();
	}

	noteActiveLeaf(leaf: WorkspaceLeaf | null): void {
		const view = leaf?.view;
		if (view instanceof MarkdownView && view.file) this.lastMarkdownPath = view.file.path;
		this.emit();
	}

	noteFile(file: TFile | null): void {
		if (file) this.lastMarkdownPath = file.path;
		this.emit();
	}

	resolve(): EditorContext | null {
		const candidates: MarkdownView[] = [];
		const active = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (active?.file) candidates.push(active);
		for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
			const v = leaf.view;
			if (v instanceof MarkdownView && v.file && v !== candidates[0]) candidates.push(v);
		}
		candidates.sort(
			(a, b) =>
				((a.file?.path === this.lastMarkdownPath ? 0 : 1) -
					(b.file?.path === this.lastMarkdownPath ? 0 : 1)),
		);
		for (const md of candidates) {
			const view = (md.editor as Editor & { cm?: EditorView }).cm;
			if (view && md.file) return { file: md.file, view };
		}
		return null;
	}
}
