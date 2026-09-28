import { ItemView, Notice, setIcon } from 'obsidian';
import type { WorkspaceLeaf } from 'obsidian';
import { CATEGORIES, CATEGORY_LABELS, SEVERITIES, SEVERITY_LABELS } from '../types';
import type { Category, Severity } from '../types';
import { renderSuggestionCard } from './card';
import { diffTexts } from '../core/diff';
import { formatClock } from '../util';
import type EditingSuggestionsPlugin from '../../main';

export const VIEW_TYPE_ES = 'editing-suggestions-view';

const MAX_DIFF_BLOCKS = 300;

export class EditingSuggestionsView extends ItemView {
  private categoryFilter: Category | 'all' = 'all';
  private severityFilter: Severity | 'all' = 'all';
  private instructionMode: 'suggest' | 'rewrite' = 'suggest';
  private instructionText = '';
  private unregister: (() => void) | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: EditingSuggestionsPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_ES;
  }

  getDisplayText(): string {
    return '编辑建议';
  }

  getIcon(): string {
    return 'spell-check';
  }

  async onOpen(): Promise<void> {
    this.unregister = this.plugin.onUIChange(() => this.render());
    this.render();
  }

  async onClose(): Promise<void> {
    this.unregister?.();
    this.unregister = null;
  }

  render(): void {
    const root = this.contentEl;
    const composerActive =
      root.querySelector('.es-composer-input') ===
      (typeof document !== 'undefined' ? document.activeElement : null);
    const composerScroll = (root.querySelector('.es-composer-input') as HTMLTextAreaElement | null)
      ?.selectionStart ?? 0;
    root.empty();
    root.addClass('es-root');
    this.renderHeader(root);
    this.renderToolbar(root);
    this.renderRewrite(root);
    this.renderList(root);
    this.renderFooter(root);
    this.renderBackups(root);
    this.renderComposer(root, composerActive, composerScroll);
  }

  /* ---------------------------------------------------------- 头部 */

  private renderHeader(container: HTMLElement): void {
    const plugin = this.plugin;
    const header = container.createDiv({ cls: 'es-header' });
    const identity = header.createDiv({ cls: 'es-identity' });
    const iconBox = identity.createDiv({ cls: 'es-brand-icon' });
    setIcon(iconBox, 'spell-check');
    const identityText = identity.createDiv({ cls: 'es-identity-text' });
    identityText.createDiv({ cls: 'es-brand', text: '编辑建议' });

    const file = plugin.getActiveFile();
    const state = file ? plugin.store.fileState(file.path) : undefined;
    const pending = state?.suggestions.filter((s) => s.status === 'pending').length ?? 0;
    const subtitle = plugin.runner.isRunning()
      ? '逐句分析中，深思考可能需要一两分钟…'
      : state?.checkedAt
        ? `上次检查 ${formatClock(state.checkedAt)} · 待处理 ${pending}`
        : pending
          ? `待处理 ${pending}`
          : '';
    identityText.createDiv({ cls: 'es-subtitle', text: subtitle });

    const running = plugin.runner.isRunning();
    const checkBtn = header.createEl('button', { cls: 'es-btn es-btn-check' });
    checkBtn.disabled = running;
    checkBtn.setText(running ? '分析中…' : '检查全文');
    checkBtn.addEventListener('click', () => void plugin.runner.run('full'));
  }

  /* ---------------------------------------------------------- 筛选 */

  private renderToolbar(container: HTMLElement): void {
    const toolbar = container.createDiv({ cls: 'es-toolbar' });
    const seg = toolbar.createDiv({ cls: 'es-seg' });
    const items: { key: Category | 'all'; label: string }[] = [
      { key: 'all', label: '全部' },
      ...CATEGORIES.map((c) => ({ key: c, label: CATEGORY_LABELS[c] })),
    ];
    for (const item of items) {
      const el = seg.createEl('button', {
        cls: `es-seg-item${this.categoryFilter === item.key ? ' is-active' : ''}`,
        text: item.label,
      });
      el.addEventListener('click', () => {
        this.categoryFilter = item.key;
        this.render();
      });
    }
    const select = toolbar.createEl('select', { cls: 'es-sev-select' });
    for (const [key, label] of [
      ['all', '全部级别'],
      ...SEVERITIES.map((s) => [s, SEVERITY_LABELS[s]] as const),
    ] as const) {
      select.createEl('option', { text: label }).value = key;
    }
    select.value = this.severityFilter;
    select.addEventListener('change', () => {
      this.severityFilter = select.value as Severity | 'all';
      this.render();
    });
  }

  /* ---------------------------------------------------------- 重写预览 */

  private renderRewrite(container: HTMLElement): void {
    const p = this.plugin.pendingRewrite;
    if (!p) return;
    const box = container.createDiv({ cls: 'es-rewrite' });
    const toolbar = box.createDiv({ cls: 'es-rewrite-toolbar' });
    toolbar.createSpan({ cls: 'es-rewrite-title', text: '改写预览' });
    const actions = toolbar.createDiv({ cls: 'es-rewrite-actions' });
    const applyBtn = actions.createEl('button', { text: '应用改写', cls: 'es-btn es-btn-accept' });
    applyBtn.addEventListener('click', () => void this.plugin.applyRewritePreview());
    const cancelBtn = actions.createEl('button', { text: '放弃', cls: 'es-btn' });
    cancelBtn.addEventListener('click', () => this.plugin.cancelRewrite());
    toolbar.createSpan({ cls: 'es-hint', text: '应用前自动快照' });

    const body = box.createDiv({ cls: 'es-rewrite-body' });
    const blocks = diffTexts(p.original, p.rewritten).slice(0, MAX_DIFF_BLOCKS);
    for (const block of blocks) {
      const el = body.createDiv({ cls: block.kind === 'same' ? 'es-rw-same' : 'es-rw-change' });
      for (const seg of block.segments) {
        if (seg.type === 'equal') {
          el.appendChild(document.createTextNode(seg.text));
        } else {
          el.createSpan({
            cls: seg.type === 'del' ? 'es-diff-del' : 'es-diff-ins',
            text: seg.text,
          });
        }
      }
    }
    box.createDiv({ cls: 'es-hint es-rewrite-instruction', text: `指令：${p.instruction}` });
  }

  /* ---------------------------------------------------------- 建议列表 */

  private renderList(container: HTMLElement): void {
    const plugin = this.plugin;
    const box = container.createDiv({ cls: 'es-list' });
    const file = plugin.getActiveFile();
    if (!file) {
      box.createDiv({ cls: 'es-empty', text: '打开一篇文档，开始逐句校对' });
      return;
    }
    const state = plugin.store.fileState(file.path);
    const suggestions = (state?.suggestions ?? []).filter(
      (s) => s.status === 'pending' || s.status === 'stale',
    );
    const marks = plugin.getActiveMarks();
    const visible = suggestions
      .filter(
        (s) =>
          (this.categoryFilter === 'all' || s.category === this.categoryFilter) &&
          (this.severityFilter === 'all' || s.severity === this.severityFilter),
      )
      .sort((a, b) => {
        const pa = marks.get(a.id);
        const pb = marks.get(b.id);
        if (pa !== undefined && pb !== undefined) return pa - pb;
        if (pa !== undefined) return -1;
        if (pb !== undefined) return 1;
        return a.createdAt - b.createdAt;
      });

    if (!visible.length) {
      box.createDiv({
        cls: 'es-empty',
        text: suggestions.length
          ? '当前筛选下没有建议'
          : '还没有建议。点击「检查全文」，或选中一段文字后右键检查。',
      });
      return;
    }
    for (const sug of visible) {
      const card = box.createDiv();
      card.setAttribute('data-es-id', sug.id);
      card.addEventListener('click', () => plugin.revealSuggestion(sug.id));
      renderSuggestionCard(card, plugin, sug, marks.has(sug.id), { showLocate: true });
    }
  }

  /* ---------------------------------------------------------- 底部操作 */

  private renderFooter(container: HTMLElement): void {
    const plugin = this.plugin;
    const file = plugin.getActiveFile();
    const pending = (plugin.store.fileState(file?.path ?? '')?.suggestions ?? []).filter(
      (s) =>
        s.status === 'pending' &&
        (this.categoryFilter === 'all' || s.category === this.categoryFilter) &&
        (this.severityFilter === 'all' || s.severity === this.severityFilter),
    );
    if (!pending.length) return;
    const box = container.createDiv({ cls: 'es-footer' });
    const acceptAll = box.createEl('button', {
      text: `接受全部（${pending.length}）`,
      cls: 'es-btn es-btn-accept',
    });
    acceptAll.addEventListener('click', () =>
      void plugin.acceptAll(this.categoryFilter, this.severityFilter),
    );
    const ignoreAll = box.createEl('button', { text: '忽略全部', cls: 'es-btn' });
    ignoreAll.addEventListener('click', () =>
      plugin.ignoreAll(this.categoryFilter, this.severityFilter),
    );
  }

  /* ---------------------------------------------------------- 备份 */

  private renderBackups(container: HTMLElement): void {
    const details = container.createEl('details', { cls: 'es-backups' });
    const summary = details.createEl('summary', { text: '备份与恢复' });
    summary.addEventListener('click', (e) => {
      e.preventDefault();
      details.open = !details.open;
      if (details.open) {
        setTimeout(() => void this.fillBackups(details, this.plugin, this.plugin.getActiveFile()), 30);
      }
    });
  }

  private async fillBackups(
    details: HTMLDetailsElement,
    plugin: EditingSuggestionsPlugin,
    file: ReturnType<EditingSuggestionsPlugin['getActiveFile']>,
  ): Promise<void> {
    const list = details.querySelector('.es-backup-list');
    list?.remove();
    const box = details.createDiv({ cls: 'es-backup-list' });
    if (!file) {
      box.createDiv({ cls: 'es-hint', text: '打开文档后可查看该篇的快照' });
      return;
    }
    const manualBtn = box.createEl('button', { text: '立即备份当前内容', cls: 'es-btn' });
    manualBtn.addEventListener('click', async () => {
      await plugin.backupCurrentFile('manual');
      await this.fillBackups(details, plugin, plugin.getActiveFile());
    });
    const backups = await plugin.listBackups();
    if (!backups.length) {
      box.createDiv({ cls: 'es-hint', text: '暂无快照。检查与批量接受时会自动备份。' });
      return;
    }
    const reasonLabels: Record<string, string> = {
      check: '检查时',
      accept: '批量接受前',
      rewrite: '重写应用前',
      restore: '恢复前',
      manual: '手动',
    };
    for (const bp of backups) {
      const row = box.createDiv({ cls: 'es-backup-row' });
      row.createSpan({
        cls: 'es-backup-time',
        text: `${formatClock(bp.mtime)} · ${reasonLabels[bp.reason] ?? '快照'}`,
      });
      const restoreBtn = row.createEl('button', { text: '恢复', cls: 'es-btn' });
      restoreBtn.addEventListener('click', () => void plugin.restoreBackup(bp.path));
    }
  }

  /* ---------------------------------------------------------- 指令输入（底部，聚焦展开） */

  private renderComposer(
    root: HTMLElement,
    wasActive: boolean,
    caret: number,
  ): void {
    const plugin = this.plugin;
    const bottom = root.createDiv({ cls: 'es-bottom' });
    const open = wasActive || this.instructionText.trim().length > 0;
    if (open) bottom.addClass('es-open');

    const area = bottom.createEl('textarea', { cls: 'es-composer-input' });
    area.placeholder = plugin.hasSelection()
      ? '自定义指令（作用于选区）…'
      : '自定义指令（作用于全文）…';
    area.value = this.instructionText;
    area.rows = 1;
    const autoGrow = (): void => {
      area.style.height = 'auto';
      area.style.height = `${Math.min(area.scrollHeight, 140)}px`;
    };
    area.addEventListener('input', () => {
      this.instructionText = area.value;
      autoGrow();
      if (this.instructionText.trim()) bottom.addClass('es-open');
    });
    area.addEventListener('focus', () => bottom.addClass('es-open'));
    area.addEventListener('blur', () => {
      if (!this.instructionText.trim()) bottom.removeClass('es-open');
    });
    autoGrow();

    const foot = bottom.createDiv({ cls: 'es-composer-foot' });
    const seg = foot.createDiv({ cls: 'es-seg' });
    const modes: { key: 'suggest' | 'rewrite'; label: string }[] = [
      { key: 'suggest', label: '建议' },
      { key: 'rewrite', label: '重写' },
    ];
    for (const mode of modes) {
      const el = seg.createEl('button', {
        cls: `es-seg-item${this.instructionMode === mode.key ? ' is-active' : ''}`,
        text: mode.label,
      });
      el.addEventListener('click', () => {
        this.instructionMode = mode.key;
        this.render();
      });
    }
    const runBtn = foot.createEl('button', { text: '运行', cls: 'es-btn es-btn-run' });
    runBtn.disabled = plugin.runner.isRunning();
    runBtn.addEventListener('click', () => {
      const text = this.instructionText.trim();
      if (!text) {
        new Notice('编辑建议：请先输入指令');
        return;
      }
      void plugin.runner.runInstruction(text, this.instructionMode);
    });

    if (wasActive) {
      area.focus();
      const pos = Math.min(caret, area.value.length);
      area.setSelectionRange(pos, pos);
    }
  }
}
