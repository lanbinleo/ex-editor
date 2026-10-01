import { Notice } from 'obsidian';
import type ExEditorPlugin from '../main';
import { paragraphRange } from '../core/paragraph';
import { createBackup } from '../storage/backup';
import { chatCompletionStream } from '../llm/client';
import { stripMarkupWrapper } from '../llm/outputClean';
import { estimateCostYuan, getPricing } from '../llm/pricing';
import { buildRewriteSystemPrompt, buildRewriteUserPrompt } from '../llm/prompts';
import type { CheckScope, RewritePreview } from '../types';

/** 全文改写的字数上限：改写无法像检查那样分批，超长一次请求既慢又贵且输出易截断 */
const REWRITE_FULL_MAX_CHARS = 30_000;

/**
 * 按指令重写（M3 双轨中的「重写式」）：
 * 范围跟随侧边栏选择器（选中/段落/全文，与检查共用）→ 流式改写 → 侧边栏 diff 预览 → 确认应用。
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

	/** 发起重写：范围跟随侧边栏选择器（选中/段落/全文，与检查共用） */
	async run(instruction: string, scope: CheckScope): Promise<void> {
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
		let from: number;
		let to: number;
		if (scope === 'full') {
			if (state.doc.length > REWRITE_FULL_MAX_CHARS) {
				new Notice(
					`全文 ${state.doc.length} 字超过改写上限（${REWRITE_FULL_MAX_CHARS}），改写无法分批，请改用选中或段落范围`,
					6000,
				);
				return;
			}
			from = 0;
			to = state.doc.length;
		} else if (scope === 'selection') {
			const sel = state.selection.main;
			if (sel.empty) {
				new Notice('请先在编辑器中选中要改写的文字');
				return;
			}
			from = sel.from;
			to = sel.to;
		} else {
			const range = paragraphRange(state);
			from = range.from;
			to = range.to;
		}
		const scopeText = state.doc.sliceString(from, to);
		if (scopeText.trim().length < 10) {
			new Notice(
				scope === 'selection'
					? '选中的文字太短，不值得改写'
					: scope === 'paragraph'
						? '光标所在段落太短，不值得改写'
						: '文档太短，不值得改写',
			);
			return;
		}

		const preview: RewritePreview = {
			path: ctx.file.path,
			scope,
			from,
			to,
			original: scopeText,
			rewritten: '',
			instruction: text,
			streaming: true,
			startedAt: Date.now(),
			reasoningChars: 0,
		};
		// 重试时替换旧预览（含失败的）；正常发起也直接顶掉未确认的旧预览
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
					onReasoningDelta: (_d, charsSoFar) => {
						preview.reasoningChars = charsSoFar;
						this.emit(120);
					},
					onContentDelta: (_d, fullSoFar) => {
						// 流式期间即剥离外围包裹（定界标签/栅栏），否则增量 diff 全文失效
						preview.rewritten = stripMarkupWrapper(fullSoFar);
						this.emit(120);
					},
				},
			);
		preview.rewritten = stripMarkupWrapper(result.content);
		preview.streaming = false;
		if (!preview.rewritten) {
			// 空输出按失败处理：全删 diff 只会满屏红，无参考价值
			preview.error = '模型未返回改写内容，请重试';
			this.emit();
			new Notice('模型未返回改写内容', 6000);
			return;
		}
		if (pricing) {
				// 费用并入会话累计（与检查共用一个口径）
				this.plugin.checker.addSessionCost(
					estimateCostYuan(pricing, result.promptTokens, result.completionTokens),
				);
			}
			this.emit();
			new Notice('改写完成，请在侧边栏预览后应用');
		} catch (err) {
			if (this.abort.signal.aborted || (err instanceof Error && err.message === '已取消')) {
				// 取消：直接丢弃预览，面板收起
				this.previews.delete(ctx.file.path);
				new Notice('已取消改写');
			} else {
				// 失败：保留面板显示错误与重试；部分输出也留作参考
				preview.streaming = false;
				preview.error = err instanceof Error ? err.message : String(err);
				this.emit();
				new Notice(`改写失败 — ${preview.error}`, 8000);
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
		if (preview.error) {
			new Notice('改写失败，请重试或放弃');
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
