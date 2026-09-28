import { Notice } from 'obsidian';
import type ExEditorPlugin from '../main';
import type { EditorContextResolver } from '../editorContext';
import type { LocatedSuggestion } from '../core/validate';
import { uniqueOccurrence } from '../core/validate';
import { appendLocated as mergeEntries } from '../core/append';
import { dropOverlaps, planBatchEdit } from '../core/apply';
import type { AcceptEdit } from '../core/apply';
import { findProtectedRanges } from '../core/protected';
import { createBackup } from '../storage/backup';
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

	constructor(
		private resolver: EditorContextResolver,
		private plugin: ExEditorPlugin,
	) {}

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

	/** 清空某文件的全部建议（快照恢复后） */
	clearFile(path: string): void {
		this.files.delete(path);
		this.emit();
	}

	/** 移除某范围内的建议（重写应用后清理，best effort） */
	removeInRange(path: string, from: number, to: number): void {
		const list = this.files.get(path);
		if (!list?.length) return;
		const kept = list.filter((e) => !(e.from >= from && e.to <= to));
		if (kept.length !== list.length) {
			this.files.set(path, kept);
			this.emit();
		}
	}

	/** 批量接受当前文档的全部 pending 建议：合并为单事务（一次 Ctrl+Z），应用前快照 */
	async acceptAll(): Promise<void> {
		const ctx = this.resolver.resolve();
		if (!ctx) {
			new Notice('没有活动的文档');
			return;
		}
		const list = this.files.get(ctx.file.path) ?? [];
		const pending = list.filter((e) => e.suggestion.status === 'pending');
		if (!pending.length) {
			new Notice('没有可接受的建议');
			return;
		}
		const docText = ctx.view.state.doc.toString();
		const edits: AcceptEdit[] = [];
		const acceptedIds: string[] = [];
		for (const entry of pending) {
			const pos = this.relocate(entry, docText);
			if (!pos) {
				entry.suggestion.status = 'stale';
				continue;
			}
			edits.push({ id: entry.suggestion.id, from: pos.from, to: pos.to, insert: entry.suggestion.replacement });
			acceptedIds.push(entry.suggestion.id);
		}
		const clean = dropOverlaps(edits);
		if (!clean.length) {
			this.emit();
			new Notice('建议均已失效，请重新检查');
			return;
		}
		// 安全规则：批量修改前必须快照
		await createBackup(
			this.plugin.app,
			this.plugin.settings.backupDir,
			this.plugin.settings.backupKeep,
			ctx.file,
			'accept',
		);
		const plan = planBatchEdit(docText.length, [], clean);
		ctx.view.dispatch({ changes: plan.changes, userEvent: 'ex.accept' });
		const applied = new Set(clean.map((e) => e.id));
		this.files.set(
			ctx.file.path,
			(this.files.get(ctx.file.path) ?? []).filter((e) => !applied.has(e.suggestion.id)),
		);
		this.emit();
		new Notice(`已应用 ${clean.length} 条修改（可 Ctrl+Z 撤销）`);
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
