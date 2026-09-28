import { Notice } from 'obsidian';
import type ExEditorPlugin from '../main';
import { paragraphRange } from '../core/paragraph';
import { createBackup } from '../storage/backup';
import { chatCompletionStream } from '../llm/client';
import { estimateCostYuan, getPricing } from '../llm/pricing';
import { buildRewriteSystemPrompt, buildRewriteUserPrompt } from '../llm/prompts';
import type { RewritePreview } from '../types';

/**
 * 按指令重写（M3 双轨中的「重写式」）：
 * 选中文字优先（无选区取光标段落）→ 流式改写 → 侧边栏 diff 预览 → 确认应用。
 * 应用前自动快照；应用为单事务，Ctrl+Z 一次撤销。
 */
export class RewriteController {
	private listeners = new Set<() => void>();
	/** 每个文件最多一个待确认的改写预览 */
	private previews = new Map<string, RewritePreview>();
	private runningPath: string | null = null;
	private abort: AbortController | null = null;
	private lastEmit = 0;

	constructor(private plugin: ExEditorPlugin) {}

	subscribe(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	private emit(throttleMs = 0): void {
		const now = Date.now();
		if (throttleMs > 0 && now - this.lastEmit < throttleMs) return;
		this.lastEmit = now;
		for (const fn of this.listeners) fn();
	}

	getPreview(path: string): RewritePreview | null {
		return this.previews.get(path) ?? null;
	}

	isRunning(path?: string): boolean {
		return path === undefined ? this.runningPath !== null : this.runningPath === path;
	}

	cancelActive(): void {
		if (this.runningPath && this.abort) {
			this.abort.abort();
			new Notice('正在取消改写…');
		}
	}

	discardPreview(path: string): void {
		this.previews.delete(path);
		this.emit();
	}

	private revalidateTimer: number | undefined;

	/** 编辑停止后（防抖）校验当前文件的预览：原文已变则直接丢弃（反正永远无法安全应用） */
	scheduleRevalidate(): void {
		if (this.revalidateTimer !== undefined) window.clearTimeout(this.revalidateTimer);
		this.revalidateTimer = window.setTimeout(() => {
			this.revalidateTimer = undefined;
			const ctx = this.plugin.resolver.resolve();
			if (!ctx) return;
			const preview = this.previews.get(ctx.file.path);
			if (!preview) return;
			if (ctx.view.state.doc.sliceString(preview.from, preview.to) !== preview.original) {
				this.previews.delete(ctx.file.path);
				this.emit();
			}
		}, 400);
	}

	/** 发起重写：选中文字优先，无选区取光标所在段落 */
	async run(instruction: string): Promise<void> {
		const text = instruction.trim();
		if (!text) {
			new Notice('请先输入改写要求');
			return;
		}
		if (this.runningPath) {
			new Notice('已有改写正在进行，请稍候');
			return;
		}
		const ctx = this.plugin.resolver.resolve();
		if (!ctx) {
			new Notice('请先打开一篇 Markdown 文档');
			return;
		}
		const { baseURL, apiKey, model } = this.plugin.settings;
		if (!baseURL || !apiKey || !model) {
			new Notice('请先在设置中配置 API 地址、密钥与模型');
			return;
		}
		const state = ctx.view.state;
		const sel = state.selection.main;
		const scope = sel.empty ? paragraphRange(state) : { from: sel.from, to: sel.to };
		const scopeText = state.doc.sliceString(scope.from, scope.to);
		if (scopeText.trim().length < 10) {
			new Notice(sel.empty ? '光标所在段落太短，不值得改写' : '选中的文字太短，不值得改写');
			return;
		}

		const preview: RewritePreview = {
			path: ctx.file.path,
			from: scope.from,
			to: scope.to,
			original: scopeText,
			rewritten: '',
			instruction: text,
			streaming: true,
			startedAt: Date.now(),
		};
		this.previews.set(ctx.file.path, preview);
		this.runningPath = ctx.file.path;
		this.abort = new AbortController();
		this.emit();

		const pricing = getPricing(this.plugin.settings, this.plugin.settings.model);
		try {
			const result = await chatCompletionStream(
				this.plugin.settings,
				[
					{ role: 'system', content: buildRewriteSystemPrompt(text) },
					{ role: 'user', content: buildRewriteUserPrompt(scopeText) },
				],
				{
					jsonMode: false,
					signal: this.abort.signal,
					onContentDelta: (_d, fullSoFar) => {
						preview.rewritten = fullSoFar;
						this.emit(120);
					},
				},
			);
			preview.rewritten = result.content.trim();
			preview.streaming = false;
			if (pricing) {
				// 费用并入会话累计（与检查共用一个口径）
				this.plugin.checker.addSessionCost(
					estimateCostYuan(pricing, result.promptTokens, result.completionTokens),
				);
			}
			this.emit();
			new Notice('改写完成，请在侧边栏预览后应用');
		} catch (err) {
			this.previews.delete(ctx.file.path);
			if (this.abort.signal.aborted || (err instanceof Error && err.message === '已取消')) {
				new Notice('已取消改写');
			} else {
				new Notice(`改写失败 — ${err instanceof Error ? err.message : String(err)}`, 8000);
			}
		} finally {
			this.runningPath = null;
			this.abort = null;
			this.emit();
		}
	}

	/** 应用预览：先快照，再单事务替换，可一次 Ctrl+Z 撤销 */
	async applyPreview(): Promise<void> {
		const ctx = this.plugin.resolver.resolve();
		if (!ctx) {
			new Notice('没有活动的文档');
			return;
		}
		const preview = this.previews.get(ctx.file.path);
		if (!preview) return;
		if (preview.streaming) {
			new Notice('改写仍在进行中');
			return;
		}
		if (ctx.view.state.doc.sliceString(preview.from, preview.to) !== preview.original) {
			this.previews.delete(ctx.file.path);
			this.emit();
			new Notice('原文已发生变化，请重新运行改写', 6000);
			return;
		}
		// 安全规则：重写应用前必须快照
		await createBackup(
			this.plugin.app,
			this.plugin.settings.backupDir,
			this.plugin.settings.backupKeep,
			ctx.file,
			'rewrite',
		);
		ctx.view.dispatch({
			changes: { from: preview.from, to: preview.to, insert: preview.rewritten },
			userEvent: 'ex.rewrite-apply',
			scrollIntoView: false,
		});
		// 清掉范围内的旧建议（位置是检查时的，best effort；残留的会灰显）
		this.plugin.suggestions.removeInRange(ctx.file.path, preview.from, preview.to);
		this.previews.delete(ctx.file.path);
		this.emit();
		new Notice('已应用改写（可 Ctrl+Z 撤销）');
	}
}
