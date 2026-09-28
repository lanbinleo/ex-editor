import { Notice } from 'obsidian';
import type ExEditorPlugin from '../main';
import { paragraphRange } from '../core/paragraph';
import { findProtectedRanges } from '../core/protected';
import { parseIssues } from '../core/parse';
import { validateAndLocate } from '../core/validate';
import { chatCompletion } from '../llm/client';
import { buildCheckUserPrompt, buildProofreadSystemPrompt } from '../llm/prompts';

/** 检查编排：一次只跑一个，完成后把建议合并进建议存储 */
export class CheckController {
	private running = false;
	private listeners = new Set<() => void>();

	constructor(private plugin: ExEditorPlugin) {}

	isRunning(): boolean {
		return this.running;
	}

	subscribe(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	private emit(): void {
		for (const fn of this.listeners) fn();
	}

	/** 检查光标所在段落，返回定位成功的建议条数（供调用方决定是否打开侧边栏） */
	async checkParagraph(): Promise<number> {
		if (this.running) {
			new Notice('已有检查正在进行，请稍候');
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
		const { from, to } = paragraphRange(state);
		if (to - from < 10) {
			new Notice('光标所在段落太短，不值得单独检查');
			return 0;
		}
		const docText = state.doc.toString();
		const scopeText = docText.slice(from, to);

		this.running = true;
		this.emit();
		try {
			const result = await chatCompletion(this.plugin.settings, [
				{ role: 'system', content: buildProofreadSystemPrompt() },
				{ role: 'user', content: buildCheckUserPrompt(scopeText) },
			]);
			const issues = parseIssues(result.content);
			const protectedRanges = findProtectedRanges(docText);
			const outcome = validateAndLocate(issues, docText, from, to, protectedRanges, 'paragraph');
			this.plugin.suggestions.commitCheckResult(ctx.file.path, from, to, outcome.accepted);
			new Notice(
				`检查完成，${outcome.accepted.length} 条建议` +
					(outcome.droppedCount ? `，${outcome.droppedCount} 条无法定位已丢弃` : ''),
			);
			return outcome.accepted.length;
		} catch (err) {
			new Notice(`检查失败 — ${err instanceof Error ? err.message : String(err)}`, 8000);
			return 0;
		} finally {
			this.running = false;
			this.emit();
		}
	}
}
