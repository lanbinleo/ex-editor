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

/** 检查编排：一次只跑一个；进度与用量经 subscribe 推给界面 */
export class CheckController {
	private running = false;
	private listeners = new Set<() => void>();
	private abort: AbortController | null = null;
	private progress: RunProgress | null = null;
	private lastSummary: RunSummary | null = null;
	private lastEmit = 0;
	/** 本次会话累计估算费用（元），插件加载起算 */
	private sessionCostYuan = 0;

	constructor(private plugin: ExEditorPlugin) {}

	isRunning(): boolean {
		return this.running;
	}

	getProgress(): RunProgress | null {
		return this.progress;
	}

	getLastSummary(): RunSummary | null {
		return this.lastSummary;
	}

	getSessionCostYuan(): number {
		return this.sessionCostYuan;
	}

	/** 用户取消进行中的检查 */
	cancel(): void {
		if (this.running && this.abort) {
			this.abort.abort();
			new Notice('正在取消…');
		}
	}

	/** 计算某个范围「现在」会检查的内容（供侧边栏预览确认；无文档返回 null） */
	previewScope(scope: CheckScope): { label: string; chars: number; text: string } | null {
		const ctx = this.plugin.resolver.resolve();
		if (!ctx) return null;
		const state = ctx.view.state;
		let label: string;
		let text: string;
		if (scope === 'full') {
			label = '全文';
			text = state.doc.toString();
		} else if (scope === 'selection') {
			const sel = state.selection.main;
			if (sel.empty) {
				const range = paragraphRange(state);
				text = state.doc.sliceString(range.from, range.to);
				label = '段落（当前无选区，将检查光标所在段落）';
			} else {
				text = state.doc.sliceString(sel.from, sel.to);
				label = '选中';
			}
		} else {
			const range = paragraphRange(state);
			text = state.doc.sliceString(range.from, range.to);
			label = '段落';
		}
		return { label, chars: text.length, text };
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

	/** 运行检查，返回定位成功的建议条数（供调用方决定是否打开侧边栏） */
	async run(scope: CheckScope): Promise<number> {
		if (this.running) {
			new Notice('已有检查正在进行，请稍候或先取消');
			return 0;
		}
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
		} else {
			let from: number;
			let to: number;
			if (scope === 'selection') {
				const sel = state.selection.main;
				if (sel.empty) {
					// 无选区回落段落
					const range = paragraphRange(state);
					if (range.to - range.from < 10) {
						new Notice('光标所在段落太短，不值得单独检查');
						return 0;
					}
					from = range.from;
					to = range.to;
				} else {
					from = sel.from;
					to = sel.to;
				}
				scopeLabel = sel.empty ? '段落' : '选区';
			} else {
				const range = paragraphRange(state);
				if (range.to - range.from < 10) {
					new Notice('光标所在段落太短，不值得单独检查');
					return 0;
				}
				from = range.from;
				to = range.to;
				scopeLabel = '段落';
			}
			batches = [{ from, to }];
		}

		this.running = true;
		this.abort = new AbortController();
		this.progress = {
			scope,
			running: true,
			batchIndex: 0,
			batchTotal: batches.length,
			phase: 'thinking',
			reasoningChars: 0,
			suggestionsSoFar: 0,
		};
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
				if (this.abort.signal.aborted) break;
				// 用户在批间修改了文档：范围已不可信，中止而不是错位检查
				if (i > 0 && ctx.view.state.doc.toString() !== docText) {
					new Notice('文档已被修改，检查中止（已完成部分保留）', 6000);
					break;
				}
				if (this.progress) {
					this.progress.batchIndex = i + 1;
					this.progress.phase = 'thinking';
				}
				this.emit();

				const result = await chatCompletionStream(
					this.plugin.settings,
					[
						{ role: 'system', content: buildProofreadSystemPrompt() },
						{ role: 'user', content: buildCheckUserPrompt(docText.slice(batch.from, batch.to)) },
					],
					{
						jsonMode: true,
						signal: this.abort.signal,
						onReasoningDelta: (_d, charsSoFar) => {
							if (!this.progress) return;
							if (this.progress.phase !== 'thinking') {
								this.progress.phase = 'thinking';
								this.emit();
							}
							this.progress.reasoningChars = charsSoFar;
							this.emit(120);
						},
						onContentDelta: () => {
							if (this.progress && this.progress.phase !== 'answering') {
								this.progress.phase = 'answering';
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
				const outcome = validateAndLocate(
					issues,
					docText,
					batch.from,
					batch.to,
					protectedRanges,
					scope === 'full' ? 'full' : scope,
				);
				this.plugin.suggestions.commitCheckResult(
					ctx.file.path,
					batch.from,
					batch.to,
					outcome.accepted,
				);
				summary.accepted += outcome.accepted.length;
				summary.dropped += outcome.droppedCount;
				if (this.progress) this.progress.suggestionsSoFar = summary.accepted;
				this.emit();
			}
		} catch (err) {
			if (this.abort.signal.aborted || (err instanceof Error && err.message === '已取消')) {
				cancelled = true;
			} else {
				new Notice(`检查失败 — ${err instanceof Error ? err.message : String(err)}`, 8000);
			}
		} finally {
			summary.durationMs = Date.now() - started;
			if (runCostYuan > 0) summary.costYuan = runCostYuan;
			this.running = false;
			this.abort = null;
			this.progress = null;
			this.lastSummary = summary;
			this.emit();
		}

		if (cancelled) {
			new Notice(`已取消（${scopeLabel}，已收 ${summary.accepted} 条建议）`);
		} else {
			const batchNote = batches.length > 1 ? `，${batches.length} 批` : '';
			new Notice(
				`${scopeLabel}检查完成${batchNote}，${summary.accepted} 条建议` +
					(summary.dropped ? `，${summary.dropped} 条无法定位已丢弃` : ''),
			);
		}
		return summary.accepted;
	}
}
