import { Notice } from 'obsidian';
import type { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { collectFindings, setFindings } from '../editor/findingsField';
import { chatCompletion } from '../llm/client';
import {
  buildCheckUserPrompt,
  buildInstructionSystemPrompt,
  buildProofreadSystemPrompt,
  buildRewriteSystemPrompt,
  buildRewriteUserPrompt,
} from '../llm/prompts';
import { findProtectedRanges } from './protected';
import { parseIssues } from './parse';
import type { LocateOutcome } from './validate';
import { validateAndLocate } from './validate';
import { hashContent } from '../util';
import type { InstructionMode } from '../types';
import type EditingSuggestionsPlugin from '../../main';

export type CheckKind = 'full' | 'selection' | 'paragraph';

/** 光标所在的「空行分隔段落块」范围 */
export function paragraphRange(state: EditorState): { from: number; to: number } {
  const head = state.selection.main.head;
  let { from, to } = state.doc.lineAt(head);
  while (from > 0) {
    const prev = state.doc.lineAt(from - 1);
    if (prev.text.trim() === '') break;
    from = prev.from;
  }
  while (to < state.doc.length) {
    const next = state.doc.lineAt(to);
    if (next.text.trim() === '') break;
    to = next.to;
  }
  return { from, to };
}

/** 检查编排：一次只跑一个，完成后把建议合并进编辑器与存储 */
export class CheckRunner {
  private running = false;

  constructor(private plugin: EditingSuggestionsPlugin) {}

  isRunning(): boolean {
    return this.running;
  }

  async run(kind: CheckKind): Promise<void> {
    if (this.running) {
      new Notice('编辑建议：已有检查正在进行，请稍候');
      return;
    }
    const ctx = this.plugin.getActiveContext();
    if (!ctx) {
      new Notice('编辑建议：请先打开一篇 Markdown 文档');
      return;
    }
    const state = ctx.view.state;
    const sel = state.selection.main;
    let from: number;
    let to: number;
    if (kind === 'full') {
      from = 0;
      to = state.doc.length;
    } else if (kind === 'selection') {
      if (sel.empty) {
        new Notice('编辑建议：请先选中要检查的文字');
        return;
      }
      from = sel.from;
      to = sel.to;
    } else {
      const range = paragraphRange(state);
      if (range.to - range.from < 10) {
        new Notice('编辑建议：光标所在段落太短，不值得单独检查');
        return;
      }
      from = range.from;
      to = range.to;
    }
    await this.runCheckOnRange(kind === 'full' ? 'full' : kind, from, to, '检查全文');
  }

  async runInstruction(instruction: string, mode: InstructionMode): Promise<void> {
    if (this.running) {
      new Notice('编辑建议：已有任务正在进行，请稍候');
      return;
    }
    const ctx = this.plugin.getActiveContext();
    if (!ctx) {
      new Notice('编辑建议：请先打开一篇 Markdown 文档');
      return;
    }
    const settings = this.plugin.settings;
    if (!settings.baseURL || !settings.apiKey || !settings.model) {
      new Notice('编辑建议：请先在设置中配置模型服务');
      return;
    }
    const state = ctx.view.state;
    const sel = state.selection.main;
    const from = sel.empty ? 0 : sel.from;
    const to = sel.empty ? state.doc.length : sel.to;
    const scopeLabel = sel.empty ? '全文' : '选区';
    const docText = state.doc.toString();
    const scopeText = docText.slice(from, to);
    if (!scopeText.trim()) {
      new Notice('编辑建议：没有可处理的内容');
      return;
    }

    this.running = true;
    this.plugin.refreshUI();
    try {
      if (mode === 'suggest') {
        const result = await chatCompletion(
          settings,
          [
            { role: 'system', content: buildInstructionSystemPrompt(instruction) },
            { role: 'user', content: buildCheckUserPrompt(scopeText) },
          ],
          { jsonMode: true },
        );
        const issues = parseIssues(result.content);
        const protectedRanges = findProtectedRanges(docText);
        const outcome = validateAndLocate(
          issues,
          docText,
          from,
          to,
          protectedRanges,
          'instruction',
        );
        this.mergeInto(ctx.view, ctx.file.path, from, to, outcome);
        this.plugin.addUsage(result.promptTokens, result.completionTokens);
        new Notice(
          `编辑建议：指令完成（${scopeLabel}），${outcome.accepted.length} 条建议` +
            (outcome.droppedCount ? `，${outcome.droppedCount} 条无法定位已丢弃` : ''),
        );
      } else {
        const result = await chatCompletion(
          settings,
          [
            { role: 'system', content: buildRewriteSystemPrompt(instruction) },
            { role: 'user', content: buildRewriteUserPrompt(scopeText) },
          ],
          { jsonMode: false },
        );
        this.plugin.addUsage(result.promptTokens, result.completionTokens);
        this.plugin.setRewritePreview({
          path: ctx.file.path,
          from,
          to,
          original: scopeText,
          rewritten: result.content.trim(),
          instruction,
        });
        new Notice(`编辑建议：改写完成（${scopeLabel}），请在侧边栏预览后应用`);
      }
    } catch (err) {
      new Notice(`编辑建议：任务失败 — ${err instanceof Error ? err.message : String(err)}`, 8000);
    } finally {
      this.running = false;
      this.plugin.refreshUI();
    }
  }

  private async runCheckOnRange(
    kind: 'full' | 'selection' | 'paragraph',
    from: number,
    to: number,
    label: string,
  ): Promise<void> {
    const ctx = this.plugin.getActiveContext();
    if (!ctx) return;
    const settings = this.plugin.settings;
    if (!settings.baseURL || !settings.apiKey || !settings.model) {
      new Notice('编辑建议：请先在设置中配置模型服务');
      return;
    }
    const docText = ctx.view.state.doc.toString();
    const scopeText = docText.slice(from, to);
    if (!scopeText.trim()) {
      new Notice('编辑建议：没有可检查的内容');
      return;
    }
    if (kind === 'full' && docText.length > settings.longDocThreshold) {
      new Notice(
        `编辑建议：全文约 ${docText.length} 字，较长，仍将单次请求全文检查（可在设置调整阈值）`,
        6000,
      );
    }

    this.running = true;
    this.plugin.refreshUI();
    try {
      const result = await chatCompletion(
        settings,
        [
          { role: 'system', content: buildProofreadSystemPrompt() },
          { role: 'user', content: buildCheckUserPrompt(scopeText) },
        ],
        { jsonMode: true },
      );
      const issues = parseIssues(result.content);
      const protectedRanges = findProtectedRanges(docText);
      const outcome = validateAndLocate(issues, docText, from, to, protectedRanges, kind);
      this.mergeInto(ctx.view, ctx.file.path, from, to, outcome);
      this.plugin.addUsage(result.promptTokens, result.completionTokens);
      if (settings.backupOnCheck) {
        void this.plugin.backupCurrentFile('check');
      }
      new Notice(
        `编辑建议：${label}完成，${outcome.accepted.length} 条建议` +
          (outcome.droppedCount ? `，${outcome.droppedCount} 条无法定位已丢弃` : ''),
      );
    } catch (err) {
      new Notice(`编辑建议：检查失败 — ${err instanceof Error ? err.message : String(err)}`, 8000);
    } finally {
      this.running = false;
      this.plugin.refreshUI();
    }
  }

  /** 把定位成功的建议合并进编辑器与持久化：范围内旧建议被替换 */
  private mergeInto(
    view: EditorView,
    path: string,
    from: number,
    to: number,
    outcome: LocateOutcome,
  ): void {
    const marks = collectFindings(view.state);
    const inScope = marks.filter((m) => m.from >= from && m.to <= to);
    const kept = marks.filter((m) => !(m.from >= from && m.to <= to));
    const added = outcome.accepted.map((a) => ({
      from: a.from,
      to: a.to,
      id: a.suggestion.id,
      category: a.suggestion.category,
    }));
    view.dispatch({ effects: setFindings.of([...kept, ...added]) });
    this.plugin.commitCheckResult(
      path,
      new Set(inScope.map((m) => m.id)),
      outcome.accepted.map((a) => a.suggestion),
      hashContent(view.state.doc.toString()),
    );
    this.plugin.refreshUI();
  }
}
