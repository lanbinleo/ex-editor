import { Notice } from 'obsidian';
import type { EditorContextResolver } from '../editorContext';
import type { LocatedSuggestion } from '../core/validate';
import { uniqueOccurrence } from '../core/validate';
import { appendLocated as mergeEntries } from '../core/append';
import { findProtectedRanges } from '../core/protected';
import type { SuggestionEntry, SuggestionStatus } from '../types';

/**
 * 建议管理（内存态，按文件路径分组，重启后清空——重新检查即可恢复）。
 * 结果采用「追加」语义：旧建议不删除，原文已被改掉的由重定位校验标 stale 灰显。
 * 安全协议：接受/定位前必须重新验证原文（先按检查时位置精确匹配，
 * 失败再全文唯一出现定位；两者都失败标记 stale，绝不猜位置）。
 */
export class SuggestionController {
	private files = new Map<string, SuggestionEntry[]>();
	private listeners = new Set<() => void>();
	private revalidateTimer: number | undefined;

	constructor(private resolver: EditorContextResolver) {}

	subscribe(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	private emit(): void {
		for (const fn of this.listeners) fn();
	}

	entries(path: string): readonly SuggestionEntry[] {
		return this.files.get(path) ?? [];
	}

	get(path: string, id: string): SuggestionEntry | undefined {
		return this.files.get(path)?.find((e) => e.suggestion.id === id);
	}

	/** 一次检查的结果入库：追加语义，按 original 去重，按位置排序 */
	appendLocated(path: string, located: LocatedSuggestion[]): void {
		const list = this.files.get(path) ?? [];
		this.files.set(path, mergeEntries(list, located));
		this.emit();
	}

	/** 一键忽略：清空当前活动文件的全部建议（含已失效灰显的） */
	ignoreAll(): void {
		const ctx = this.resolver.resolve();
		if (!ctx) return;
		this.files.delete(ctx.file.path);
		this.emit();
	}

	remove(path: string, id: string): void {
		const list = this.files.get(path);
		if (!list) return;
		this.files.set(
			path,
			list.filter((e) => e.suggestion.id !== id),
		);
		this.emit();
	}

	setStatus(path: string, id: string, status: SuggestionStatus): void {
		const entry = this.get(path, id);
		if (entry) entry.suggestion.status = status;
		this.emit();
	}

	/** 在当前文档中重新定位一条建议；失败返回 null（原文已变或不再唯一） */
	private relocate(entry: SuggestionEntry, docText: string): { from: number; to: number } | null {
		if (docText.slice(entry.from, entry.to) === entry.suggestion.original) {
			return { from: entry.from, to: entry.to };
		}
		const at = uniqueOccurrence(
			entry.suggestion.original,
			docText,
			0,
			docText.length,
			findProtectedRanges(docText),
		);
		return at === null ? null : { from: at, to: at + entry.suggestion.original.length };
	}

	/** 编辑停止后（防抖）重校验当前文档的建议：原文找不到的标 stale 灰显 */
	scheduleRevalidate(): void {
		if (this.revalidateTimer !== undefined) window.clearTimeout(this.revalidateTimer);
		this.revalidateTimer = window.setTimeout(() => {
			this.revalidateTimer = undefined;
			const ctx = this.resolver.resolve();
			if (!ctx) return;
			const list = this.files.get(ctx.file.path);
			if (!list?.length) return;
			const docText = ctx.view.state.doc.toString();
			let changed = false;
			for (const entry of list) {
				if (entry.suggestion.status !== 'pending') continue;
				if (!this.relocate(entry, docText)) {
					entry.suggestion.status = 'stale';
					changed = true;
				}
			}
			if (changed) this.emit();
		}, 600);
	}

	/** 接受一条建议：单事务替换，Ctrl+Z 一次撤销 */
	accept(id: string): void {
		const ctx = this.resolver.resolve();
		if (!ctx) {
			new Notice('没有活动的文档');
			return;
		}
		const entry = this.get(ctx.file.path, id);
		if (!entry) return;
		const docText = ctx.view.state.doc.toString();
		const pos = this.relocate(entry, docText);
		if (!pos) {
			this.setStatus(ctx.file.path, id, 'stale');
			new Notice('原文已变化，无法安全应用这条建议');
			return;
		}
		ctx.view.dispatch({
			changes: { from: pos.from, to: pos.to, insert: entry.suggestion.replacement },
			userEvent: 'ex.accept',
			scrollIntoView: false,
		});
		this.remove(ctx.file.path, id);
	}

	ignore(id: string): void {
		const ctx = this.resolver.resolve();
		if (!ctx) return;
		this.remove(ctx.file.path, id);
	}

	/** 在编辑器中选中并滚动到建议原文 */
	reveal(id: string): void {
		const ctx = this.resolver.resolve();
		if (!ctx) {
			new Notice('没有活动的文档');
			return;
		}
		const entry = this.get(ctx.file.path, id);
		if (!entry) return;
		const pos = this.relocate(entry, ctx.view.state.doc.toString());
		if (!pos) {
			new Notice('无法定位原文（可能已被修改）');
			return;
		}
		ctx.view.dispatch({
			selection: { anchor: pos.from, head: pos.to },
			scrollIntoView: true,
		});
		ctx.view.focus();
	}
}
