import { Notice } from 'obsidian';
import type ExEditorPlugin from '../main';
import { paragraphRange } from '../core/paragraph';
import { splitIntoBatches } from '../core/batch';
import type { Batch } from '../core/batch';
import { findProtectedRanges } from '../core/protected';
import { parseIssues } from '../core/parse';
import { validateAndLocate } from '../core/validate';
import { chatCompletionStream } from '../llm/client';
import { estimateCostYuan, getPricing } from '../llm/pricing';
import { buildCheckUserPrompt, buildProofreadSystemPrompt } from '../llm/prompts';

export type CheckScope = 'paragraph' | 'selection' | 'full';

/** 全文分批目标字数（顺序执行，避免限流） */
const BATCH_MAX_CHARS = 3000;

export interface RunProgress {
	scope: CheckScope;
	running: boolean;
	/** 1-based；非分批检查为 0 */
	batchIndex: number;
	batchTotal: number;
	phase: 'thinking' | 'answering';
	/** 本次运行累计的思考字数（流式增量统计） */
	reasoningChars: number;
	/** 已入库的建议条数 */
	suggestionsSoFar: number;
}

export interface RunSummary {
	scope: CheckScope;
	accepted: number;
	dropped: number;
	promptTokens: number;
	completionTokens: number;
	reasoningTokens?: number;
	durationMs: number;
	batches: number;
	/** 本次运行估算费用（元）；模型无价格配置时省略 */
	costYuan?: number;
}

/** 一个文件的进行中检查 */
interface FileRun {
	abort: AbortController;
	progress: RunProgress;
}

/**
 * 检查编排。状态按文件路径隔离：不同文件可并行检查互不干扰，
 * 侧边栏只展示当前活动文件自己的进度与结果。
 */
export class CheckController {
	private listeners = new Set<() => void>();
	private runs = new Map<string, FileRun>();
	private summaries = new Map<string, RunSummary>();
	private lastEmit = 0;
	/** 本次会话累计估算费用（元，跨文件），插件加载起算 */
	private sessionCostYuan = 0;

	constructor(private plugin: ExEditorPlugin) {}

	/** 是否有检查进行中（可限定某文件） */
	isRunning(path?: string): boolean {
		return path === undefined ? this.runs.size > 0 : this.runs.has(path);
	}

	getProgress(path: string): RunProgress | null {
		return this.runs.get(path)?.progress ?? null;
	}

	getLastSummary(path: string): RunSummary | null {
		return this.summaries.get(path) ?? null;
	}

	getSessionCostYuan(): number {
		return this.sessionCostYuan;
	}

	/** 取消当前活动文件的检查（侧边栏取消按钮） */
	cancelActive(): void {
		const ctx = this.plugin.resolver.resolve();
		if (!ctx) return;
		const run = this.runs.get(ctx.file.path);
		if (run) {
			run.abort.abort();
			new Notice('正在取消…');
		}
	}

	/** 取消全部进行中的检查（命令面板） */
	cancelAll(): void {
		if (!this.runs.size) return;
		for (const run of this.runs.values()) run.abort.abort();
		new Notice(`正在取消 ${this.runs.size} 个进行中的检查…`);
	}

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

	/** 计算某个范围「现在」会检查的内容（供侧边栏预览；无文档返回 null） */
	previewScope(scope: CheckScope): { label: string; chars: number; text: string } | null {
		const ctx = this.plugin.resolver.resolve();
		if (!ctx) return null;
		const state = ctx.view.state;
		if (scope === 'full') {
			const text = state.doc.toString();
			return { label: '全文', chars: text.length, text };
		}
		if (scope === 'selection') {
			const sel = state.selection.main;
			if (sel.empty) {
				return { label: '待选中', chars: 0, text: '请先在编辑器中选中要检查的文字' };
			}
			const text = state.doc.sliceString(sel.from, sel.to);
			return { label: '选中', chars: text.length, text };
		}
		const range = paragraphRange(state);
		const text = state.doc.sliceString(range.from, range.to);
		return { label: '段落', chars: text.length, text };
	}

	/** 运行检查，返回定位成功的建议条数（供调用方决定是否打开侧边栏） */
	async run(scope: CheckScope): Promise<number> {
		const ctx = this.plugin.resolver.resolve();
		if (!ctx) {
			new Notice('请先打开一篇 Markdown 文档');
			return 0;
		}
		const { baseURL, apiKey, model } = this.plugin.settings;
		if (!baseURL || !apiKey || !model) {
			new Notice('请先在设置中配置 API 地址、密钥与模型');
			return 0;
		}
		const path = ctx.file.path;
		if (this.runs.has(path)) {
			new Notice('这篇文档已有检查正在进行');
			return 0;
		}
		const state = ctx.view.state;
		const docText = state.doc.toString();

		let batches: Batch[];
		let scopeLabel: string;
		if (scope === 'full') {
			const lines: { from: number; to: number; text: string }[] = [];
			for (let n = 1; n <= state.doc.lines; n++) {
				const line = state.doc.line(n);
				lines.push({ from: line.from, to: line.to, text: line.text });
			}
			batches = splitIntoBatches(lines, BATCH_MAX_CHARS);
			if (!batches.length) {
				new Notice('文档没有可检查的内容');
				return 0;
			}
			scopeLabel = '全文';
		} else if (scope === 'selection') {
			const sel = state.selection.main;
			if (sel.empty) {
				new Notice('请先选中要检查的文字');
				return 0;
			}
			batches = [{ from: sel.from, to: sel.to }];
			scopeLabel = '选区';
		} else {
			const range = paragraphRange(state);
			if (range.to - range.from < 10) {
				new Notice('光标所在段落太短，不值得单独检查');
				return 0;
			}
			batches = [{ from: range.from, to: range.to }];
			scopeLabel = '段落';
		}

		const run: FileRun = {
			abort: new AbortController(),
			progress: {
				scope,
				running: true,
				batchIndex: 0,
				batchTotal: batches.length,
				phase: 'thinking',
				reasoningChars: 0,
				suggestionsSoFar: 0,
			},
		};
		this.runs.set(path, run);
		this.emit();

		const summary: RunSummary = {
			scope,
			accepted: 0,
			dropped: 0,
			promptTokens: 0,
			completionTokens: 0,
			durationMs: 0,
			batches: batches.length,
		};
		// 价格在运行开始时定格（模型中途改价不影响本次估算）
		const runPricing = getPricing(this.plugin.settings, this.plugin.settings.model);
		let runCostYuan = 0;
		const started = Date.now();
		let cancelled = false;

		try {
			for (let i = 0; i < batches.length; i++) {
				const batch = batches[i];
				if (!batch) continue;
				if (run.abort.signal.aborted) break;
				// 用户在批间修改了文档：范围已不可信，中止而不是错位检查
				if (i > 0 && ctx.view.state.doc.toString() !== docText) {
					new Notice('文档已被修改，检查中止（已收到的建议保留）', 6000);
					break;
				}
				run.progress.batchIndex = i + 1;
				run.progress.phase = 'thinking';
				this.emit();

				const result = await chatCompletionStream(
					this.plugin.settings,
					[
						{ role: 'system', content: buildProofreadSystemPrompt() },
						{ role: 'user', content: buildCheckUserPrompt(docText.slice(batch.from, batch.to)) },
					],
					{
						jsonMode: true,
						signal: run.abort.signal,
						onReasoningDelta: (_d, charsSoFar) => {
							if (run.progress.phase !== 'thinking') {
								run.progress.phase = 'thinking';
								this.emit();
							}
							run.progress.reasoningChars = charsSoFar;
							this.emit(120);
						},
						onContentDelta: () => {
							if (run.progress.phase !== 'answering') {
								run.progress.phase = 'answering';
								this.emit();
							}
						},
					},
				);
				summary.promptTokens += result.promptTokens;
				summary.completionTokens += result.completionTokens;
				summary.reasoningTokens =
					(summary.reasoningTokens ?? 0) + (result.reasoningTokens ?? 0) || undefined;
				if (runPricing) {
					const batchCost = estimateCostYuan(
						runPricing,
						result.promptTokens,
						result.completionTokens,
					);
					runCostYuan += batchCost;
					this.sessionCostYuan += batchCost;
				}

				const issues = parseIssues(result.content);
				const protectedRanges = findProtectedRanges(docText);
				const outcome = validateAndLocate(issues, docText, batch.from, batch.to, protectedRanges, scope);
				this.plugin.suggestions.appendLocated(path, outcome.accepted);
				summary.accepted += outcome.accepted.length;
				summary.dropped += outcome.droppedCount;
				run.progress.suggestionsSoFar = summary.accepted;
				this.emit();
			}
		} catch (err) {
			if (run.abort.signal.aborted || (err instanceof Error && err.message === '已取消')) {
				cancelled = true;
			} else {
				new Notice(`检查失败 — ${err instanceof Error ? err.message : String(err)}`, 8000);
			}
		} finally {
			summary.durationMs = Date.now() - started;
			if (runCostYuan > 0) summary.costYuan = runCostYuan;
			this.runs.delete(path);
			this.summaries.set(path, summary);
			this.emit();
		}

		if (cancelled) {
			new Notice(`已取消（${scopeLabel}，已收 ${summary.accepted} 条建议）`);
		} else {
			const batchNote = batches.length > 1 ? `，${batches.length} 批` : '';
			new Notice(
				`${scopeLabel}检查完成${batchNote}，新收 ${summary.accepted} 条建议` +
					(summary.dropped ? `，${summary.dropped} 条无法定位已丢弃` : ''),
			);
		}
		return summary.accepted;
	}
}
