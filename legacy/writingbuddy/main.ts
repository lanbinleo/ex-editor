import { Editor, MarkdownView, Menu, Notice, Plugin, TFile } from 'obsidian';
import type { EditorView } from '@codemirror/view';
import { buildEditorExtensions } from './src/editor/extensions';
import {
  collectFindings,
  findMarkAt,
  setActiveFinding,
  setFindings,
} from './src/editor/findingsField';
import { CheckRunner } from './src/core/checkService';
import { findProtectedRanges } from './src/core/protected';
import { dropOverlaps, planBatchEdit } from './src/core/apply';
import type { AcceptEdit } from './src/core/apply';
import { relocateSuggestions, uniqueOccurrence } from './src/core/validate';
import { Store } from './src/storage/store';
import {
  createBackup,
  listBackups as listBackupsForFile,
  readBackup,
} from './src/storage/backup';
import type { BackupInfo } from './src/storage/backup';
import { VIEW_TYPE_ES, EditingSuggestionsView } from './src/view/sidebar';
import { EditingSuggestionsSettingTab } from './src/settings';
import { debounce, hashContent, truncate } from './src/util';
import type {
  BuddyActions,
  Category,
  RewritePreview,
  Severity,
  Suggestion,
  WBSettings,
} from './src/types';

export default class EditingSuggestionsPlugin extends Plugin implements BuddyActions {
  public store!: Store;
  public runner!: CheckRunner;
  public pendingRewrite: RewritePreview | null = null;
  /** 继承自 Plugin 的 settings 属性（unknown），此处收窄为插件设置 */
  declare settings: WBSettings;
  private uiListeners = new Set<() => void>();
  private statusbarEl: HTMLElement | null = null;
  private lastRestoredPath = '';
  /** 最近编辑过的文档路径：侧边栏获得焦点后，操作仍然作用于它 */
  private lastMarkdownPath = '';

  async onload(): Promise<void> {
    this.store = new Store();
    await this.store.load(this);
    this.settings = this.store.data.settings;
    this.runner = new CheckRunner(this);

    this.registerView(VIEW_TYPE_ES, (leaf) => new EditingSuggestionsView(leaf, this));
    this.registerEditorExtension(buildEditorExtensions(this));

    this.addRibbonIcon('spell-check', '编辑建议', () => void this.activateView());

    this.addCommand({
      id: 'open-sidebar',
      name: '打开编辑建议面板',
      callback: () => void this.activateView(),
    });
    this.addCommand({
      id: 'check-full',
      name: '检查全文语法',
      callback: () => void this.runner.run('full'),
    });
    this.addCommand({
      id: 'check-scope',
      name: '检查选中文字（无选区时检查本段落）',
      callback: () => void this.runner.run(this.hasSelection() ? 'selection' : 'paragraph'),
    });
    this.addCommand({
      id: 'accept-all',
      name: '接受全部建议',
      callback: () => void this.acceptAll('all', 'all'),
    });
    this.addCommand({
      id: 'ignore-all',
      name: '忽略全部建议',
      callback: () => this.ignoreAll('all', 'all'),
    });

    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu: Menu, editor: Editor) => {
        this.onEditorMenu(menu, editor);
      }),
    );
    this.registerEvent(
      this.app.workspace.on('file-open', (file) => {
        if (file instanceof TFile) this.lastMarkdownPath = file.path;
        this.scheduleRestore();
        this.refreshUI();
      }),
    );
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', (leaf) => {
        const view = leaf?.view;
        if (view instanceof MarkdownView && view.file instanceof TFile) {
          this.lastMarkdownPath = view.file.path;
        }
        // 只刷新状态栏与建议标记，不重建侧边栏——
        // 焦点落到侧边栏时若整体重渲染，会吞掉正在按下的按钮
        this.scheduleRestore();
        this.updateStatusbar();
      }),
    );

    this.addSettingTab(new EditingSuggestionsSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      const el = this.addStatusBarItem();
      el.addClass('es-statusbar');
      el.addEventListener('click', () => void this.activateView());
      this.statusbarEl = el;
      this.scheduleRestore();
    });
  }

  onunload(): void {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_ES);
  }

  async saveSettings(): Promise<void> {
    this.store.queueSave();
  }

  // ---------- UI 事件 ----------

  onUIChange(callback: () => void): () => void {
    this.uiListeners.add(callback);
    return () => this.uiListeners.delete(callback);
  }

  refreshUI(): void {
    this.updateStatusbar();
    for (const cb of this.uiListeners) cb();
  }

  private updateStatusbar(): void {
    if (!this.statusbarEl) return;
    const file = this.getActiveFile();
    const pending = file
      ? (this.store.fileState(file.path)?.suggestions ?? []).filter(
          (s) => s.status === 'pending',
        ).length
      : 0;
    this.statusbarEl.setText(
      this.runner?.isRunning()
        ? '建议 · 分析中…'
        : pending > 0
          ? `建议 · ${pending} 条`
          : '',
    );
  }

  // ---------- 上下文 ----------

  private cmOf(editor: Editor): EditorView | null {
    return (editor as Editor & { cm?: EditorView }).cm ?? null;
  }

  /**
   * 解析「当前操作的文档」：
   * 1. 焦点在 Markdown 视图上时就是它；
   * 2. 焦点在侧边栏/设置页时，回落到最近编辑过的那篇——用户点开侧边栏后，
   *    所有动作应继续作用于原文档，而不是要求重新打开；
   * 3. 都没有时取任意打开的 Markdown 视图。
   */
  getActiveContext(): { file: TFile; view: EditorView } | null {
    const candidates: MarkdownView[] = [];
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active && active.file instanceof TFile) candidates.push(active);
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const v = leaf.view;
      if (v instanceof MarkdownView && v.file instanceof TFile && v !== candidates[0]) {
        candidates.push(v);
      }
    }
    candidates.sort((a, b) => {
      const pa = (a.file as TFile).path === this.lastMarkdownPath ? 0 : 1;
      const pb = (b.file as TFile).path === this.lastMarkdownPath ? 0 : 1;
      return pa - pb;
    });
    for (const md of candidates) {
      const view = this.cmOf(md.editor);
      if (view) return { file: md.file as TFile, view };
    }
    return null;
  }

  getActiveFile(): TFile | null {
    return this.getActiveContext()?.file ?? null;
  }

  hasSelection(): boolean {
    const ctx = this.getActiveContext();
    return !!ctx && !ctx.view.state.selection.main.empty;
  }

  /** id → from 位置；无活动编辑器时为空 */
  getActiveMarks(): Map<string, number> {
    const ctx = this.getActiveContext();
    const map = new Map<string, number>();
    if (ctx) {
      for (const m of collectFindings(ctx.view.state)) map.set(m.id, m.from);
    }
    return map;
  }

  // ---------- BuddyActions ----------

  getSuggestion(id: string): Suggestion | undefined {
    const active = this.getActiveFile();
    if (active) {
      const found = this.store.getSuggestion(active.path, id);
      if (found) return found;
    }
    for (const state of Object.values(this.store.data.files)) {
      const found = state.suggestions.find((s) => s.id === id);
      if (found) return found;
    }
    return undefined;
  }

  acceptSuggestion(id: string): void {
    const ctx = this.getActiveContext();
    if (!ctx) {
      new Notice('编辑建议：没有活动的文档');
      return;
    }
    const sug = this.store.getSuggestion(ctx.file.path, id);
    if (!sug) return;
    const marks = collectFindings(ctx.view.state);
    const mark = marks.find((m) => m.id === id);
    let from: number | null = null;
    let to = 0;
    if (mark && ctx.view.state.doc.sliceString(mark.from, mark.to) === sug.original) {
      from = mark.from;
      to = mark.to;
    } else {
      const docText = ctx.view.state.doc.toString();
      const at = uniqueOccurrence(
        sug.original,
        docText,
        0,
        docText.length,
        findProtectedRanges(docText),
      );
      if (at !== null) {
        from = at;
        to = at + sug.original.length;
      }
    }
    if (from === null) {
      this.store.setStatus(ctx.file.path, id, 'stale');
      this.refreshUI();
      new Notice('编辑建议：原文已变化，无法安全应用这条建议');
      return;
    }
    ctx.view.dispatch(
      planBatchEdit(ctx.view.state.doc.length, marks, [
        { id, from, to, insert: sug.replacement },
      ]),
    );
    this.store.setStatus(ctx.file.path, id, 'accepted');
    this.refreshUI();
  }

  ignoreSuggestion(id: string): void {
    const ctx = this.getActiveContext();
    if (!ctx) return;
    this.store.setStatus(ctx.file.path, id, 'ignored');
    const marks = collectFindings(ctx.view.state).filter((m) => m.id !== id);
    ctx.view.dispatch({ effects: setFindings.of(marks) });
    this.refreshUI();
  }

  revealSuggestion(id: string): void {
    const ctx = this.getActiveContext();
    if (!ctx) {
      new Notice('编辑建议：没有活动的文档');
      return;
    }
    let mark = collectFindings(ctx.view.state).find((m) => m.id === id);
    if (!mark) {
      const sug = this.store.getSuggestion(ctx.file.path, id);
      if (sug) {
        const docText = ctx.view.state.doc.toString();
        const at = uniqueOccurrence(
          sug.original,
          docText,
          0,
          docText.length,
          findProtectedRanges(docText),
        );
        if (at !== null) {
          mark = { from: at, to: at + sug.original.length, id, category: sug.category };
        }
      }
    }
    if (!mark) {
      new Notice('编辑建议：无法定位原文（可能已被修改）');
      return;
    }
    ctx.view.dispatch({
      selection: { anchor: mark.from, head: mark.to },
      effects: setActiveFinding.of(id),
      scrollIntoView: true,
    });
    ctx.view.focus();
  }

  focusSidebarCard(id: string): void {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_ES);
    if (!leaves.length) return;
    const container = leaves[0].view.containerEl;
    const selector = `[data-es-id="${
      typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id
    }"]`;
    const card = container.querySelector<HTMLElement>(selector);
    if (!card) return;
    card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    card.addClass('es-flash');
    setTimeout(() => card.removeClass('es-flash'), 1200);
  }

  // ---------- 批量操作 ----------

  async acceptAll(
    categoryFilter: Category | 'all',
    severityFilter: Severity | 'all',
  ): Promise<void> {
    const ctx = this.getActiveContext();
    if (!ctx) {
      new Notice('编辑建议：没有活动的文档');
      return;
    }
    const path = ctx.file.path;
    const state = this.store.ensureFileState(path);
    const targets = state.suggestions.filter(
      (s) =>
        s.status === 'pending' &&
        (categoryFilter === 'all' || s.category === categoryFilter) &&
        (severityFilter === 'all' || s.severity === severityFilter),
    );
    if (!targets.length) {
      new Notice('编辑建议：没有可接受的建议');
      return;
    }
    const docText = ctx.view.state.doc.toString();
    const protectedRanges = findProtectedRanges(docText);
    const marks = collectFindings(ctx.view.state);
    const edits: AcceptEdit[] = [];
    for (const sug of targets) {
      const mark = marks.find((m) => m.id === sug.id);
      let from: number | null = null;
      let to = 0;
      if (mark && ctx.view.state.doc.sliceString(mark.from, mark.to) === sug.original) {
        from = mark.from;
        to = mark.to;
      } else {
        const at = uniqueOccurrence(sug.original, docText, 0, docText.length, protectedRanges);
        if (at !== null) {
          from = at;
          to = at + sug.original.length;
        }
      }
      if (from === null) {
        this.store.setStatus(path, sug.id, 'stale');
        continue;
      }
      edits.push({ id: sug.id, from, to, insert: sug.replacement });
    }
    const clean = dropOverlaps(edits);
    if (!clean.length) {
      this.refreshUI();
      new Notice('编辑建议：建议均已失效，请重新检查');
      return;
    }
    if (clean.length > 1) await this.backupCurrentFile('accept');
    ctx.view.dispatch(planBatchEdit(ctx.view.state.doc.length, marks, clean));
    for (const edit of clean) this.store.setStatus(path, edit.id, 'accepted');
    this.refreshUI();
    new Notice(`编辑建议：已应用 ${clean.length} 条修改（可 Ctrl+Z 撤销）`);
  }

  ignoreAll(categoryFilter: Category | 'all', severityFilter: Severity | 'all'): void {
    const ctx = this.getActiveContext();
    if (!ctx) return;
    const state = this.store.fileState(ctx.file.path);
    if (!state) return;
    const ignored = new Set(
      state.suggestions
        .filter(
          (s) =>
            s.status === 'pending' &&
            (categoryFilter === 'all' || s.category === categoryFilter) &&
            (severityFilter === 'all' || s.severity === severityFilter),
        )
        .map((s) => s.id),
    );
    if (!ignored.size) return;
    for (const id of ignored) this.store.setStatus(ctx.file.path, id, 'ignored');
    const marks = collectFindings(ctx.view.state).filter((m) => !ignored.has(m.id));
    ctx.view.dispatch({ effects: setFindings.of(marks) });
    this.refreshUI();
  }

  // ---------- 检查结果与重写 ----------

  commitCheckResult(
    path: string,
    removedIds: Set<string>,
    added: Suggestion[],
    contentHash: string,
  ): void {
    this.store.commitCheckResult(path, removedIds, added, contentHash);
    this.refreshUI();
  }

  addUsage(promptTokens: number, completionTokens: number): void {
    this.store.addUsage(promptTokens, completionTokens);
    this.refreshUI();
  }

  setRewritePreview(preview: RewritePreview): void {
    this.pendingRewrite = preview;
    this.refreshUI();
  }

  cancelRewrite(): void {
    this.pendingRewrite = null;
    this.refreshUI();
  }

  async applyRewritePreview(): Promise<void> {
    const p = this.pendingRewrite;
    if (!p) return;
    const ctx = this.getActiveContext();
    if (!ctx || ctx.file.path !== p.path) {
      new Notice('编辑建议：请切回原文档后再应用');
      return;
    }
    if (ctx.view.state.doc.sliceString(p.from, p.to) !== p.original) {
      this.pendingRewrite = null;
      this.refreshUI();
      new Notice('编辑建议：文章已发生变化，请重新运行指令', 6000);
      return;
    }
    await this.backupCurrentFile('rewrite');
    const marks = collectFindings(ctx.view.state);
    const removed = new Set(
      marks.filter((m) => m.from >= p.from && m.to <= p.to).map((m) => m.id),
    );
    ctx.view.dispatch(
      planBatchEdit(ctx.view.state.doc.length, marks, [
        { id: '__rewrite__', from: p.from, to: p.to, insert: p.rewritten },
      ]),
    );
    this.store.removeSuggestions(p.path, removed);
    this.pendingRewrite = null;
    this.refreshUI();
    new Notice('编辑建议：已应用改写（可 Ctrl+Z 撤销）');
  }

  // ---------- 备份 ----------

  async backupCurrentFile(reason: string): Promise<string | null> {
    const file = this.getActiveFile();
    if (!file) return null;
    return createBackup(this.app, this.settings, file, reason);
  }

  async listBackups(): Promise<BackupInfo[]> {
    const file = this.getActiveFile();
    if (!file) return [];
    return listBackupsForFile(this.app, this.settings, file);
  }

  async restoreBackup(backupPath: string): Promise<void> {
    const file = this.getActiveFile();
    if (!file) {
      new Notice('编辑建议：没有活动的文档');
      return;
    }
    try {
      const content = await readBackup(this.app, backupPath);
      await this.backupCurrentFile('restore');
      await this.app.vault.process(file, () => content);
      this.store.setFileSuggestions(file.path, [], hashContent(content));
      if (this.pendingRewrite?.path === file.path) this.pendingRewrite = null;
      const ctx = this.getActiveContext();
      if (ctx && ctx.file.path === file.path) {
        ctx.view.dispatch({ effects: setFindings.of([]) });
      }
      this.refreshUI();
      new Notice('编辑建议：已从备份恢复（恢复前内容已另行快照）');
    } catch (e) {
      new Notice(`编辑建议：恢复失败 — ${e instanceof Error ? e.message : String(e)}`, 8000);
    }
  }

  // ---------- 侧边栏 ----------

  async activateView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_ES);
    if (existing.length) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE_ES, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  // ---------- 内部 ----------

  private onEditorMenu(menu: Menu, editor: Editor): void {
    const view = (editor as Editor & { cm?: EditorView }).cm;
    if (!view) return;
    const sel = view.state.selection.main;
    if (!sel.empty) {
      menu.addItem((item) =>
        item
          .setTitle('编辑建议：检查选中文字')
          .setIcon('spell-check')
          .onClick(() => void this.runner.run('selection')),
      );
    } else {
      menu.addItem((item) =>
        item
          .setTitle('编辑建议：检查本段落')
          .setIcon('spell-check')
          .onClick(() => void this.runner.run('paragraph')),
      );
    }
    const mark = findMarkAt(view.state, view.state.selection.main.head);
    if (mark) {
      const sug = this.getSuggestion(mark.id);
      menu.addSeparator();
      menu.addItem((item) =>
        item
          .setTitle(`编辑建议：接受「${truncate(sug?.replacement ?? '', 12)}」`)
          .onClick(() => this.acceptSuggestion(mark.id)),
      );
      menu.addItem((item) =>
        item.setTitle('编辑建议：忽略此建议').onClick(() => this.ignoreSuggestion(mark.id)),
      );
    }
  }

  private scheduleRestore = debounce(() => this.restoreActiveFile(), 200);

  /**
   * 打开/切换文件时，把持久化的建议重新定位并标注到编辑器。
   * 同一文件且标记仍在时跳过——编辑期间标记由 CM6 自动映射，
   * 不重新定位，避免把仍有效的建议误判为 stale。
   */
  private restoreActiveFile(): void {
    const ctx = this.getActiveContext();
    if (!ctx) {
      this.updateStatusbar();
      return;
    }
    const path = ctx.file.path;
    const existing = collectFindings(ctx.view.state);
    if (path === this.lastRestoredPath && existing.length > 0) {
      this.updateStatusbar();
      return;
    }
    this.lastRestoredPath = path;
    const docText = ctx.view.state.doc.toString();
    const state = this.store.fileState(path);
    const pending = (state?.suggestions ?? []).filter((s) => s.status === 'pending');
    const result = relocateSuggestions(pending, docText, findProtectedRanges(docText));
    const marks = result.marks.map((m) => ({
      from: m.from,
      to: m.to,
      id: m.suggestion.id,
      category: m.suggestion.category,
    }));
    for (const id of result.staleIds) this.store.setStatus(path, id, 'stale');
    ctx.view.dispatch({ effects: setFindings.of(marks) });
    this.refreshUI();
  }
}
