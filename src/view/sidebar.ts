import { ItemView, Menu, setIcon, setTooltip } from 'obsidian';
import type { WorkspaceLeaf } from 'obsidian';
import type ExEditorPlugin from '../main';
import type { ActiveRun, CheckScope, RunProgress } from '../controller/checkController';
import { diffTexts, trimTrailingDeletions } from '../core/diff';
import type { DiffBlock } from '../core/diff';
import { formatYuan } from '../llm/pricing';
import { STRENGTH_LABELS } from '../types';
import type { CheckStrength, RewritePreview } from '../types';
import { truncate } from '../util';
import { appendSegs, renderSuggestionCard, updateCardState } from './card';

export const VIEW_TYPE_EX_SIDEBAR = 'exeditor-sidebar';

/** 卡片进/离场动画时长（与 CSS 保持一致） */
const ENTER_MS = 200;
const LEAVE_MS = 220;
/** 范围预览的最大字符数 */
const SCOPE_PREVIEW_CHARS = 160;
/** 重写预览 diff 块数上限 */
const MAX_DIFF_BLOCKS = 300;

const SCOPE_OPTIONS: Record<CheckScope, { label: string; icon: string }> = {
	paragraph: { label: '段落', icon: 'pilcrow' },
	selection: { label: '选中', icon: 'text-cursor-input' },
	full: { label: '全文', icon: 'file-text' },
};

const STRENGTH_ICONS: Record<CheckStrength, string> = {
	light: 'type',
	standard: 'list-checks',
	deep: 'sparkles',
};

function fmtTokens(n: number): string {
	if (n < 1000) return String(n);
	const k = n / 1000;
	return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}k`;
}

function fmtDuration(ms: number): string {
	const sec = Math.round(ms / 1000);
	if (sec < 60) return `${sec}s`;
	return `${Math.floor(sec / 60)}m${sec % 60}s`;
}

/** 按钮内容 = 图标 + 可选文字 */
function fillButton(btn: HTMLElement, icon: string, text?: string): void {
	btn.empty();
	setIcon(btn.createSpan({ cls: 'ex-btn-icon' }), icon);
	if (text !== undefined) btn.createSpan({ cls: 'ex-btn-text', text });
}

/**
 * 侧边栏：三段式布局——顶栏（范围/强度/检查）固定、中间结果区滚动、底部指令输入固定。
 * 架构红线：建议卡片按条目 id 精确增删改（复用 DOM 节点、保留焦点与滚动），
 * 绝不做 root.empty() 式整体重渲染——这是旧版插件的核心病灶。
 */
export class ExSidebarView extends ItemView {
	private cards = new Map<string, HTMLElement>();
	private unsubscribers: (() => void)[] = [];
	private checkScope: CheckScope = 'paragraph';
	private instructionText = '';
	private lastPreviewKey = '';
	private scopeBtn!: HTMLButtonElement;
	private strengthBtn!: HTMLButtonElement;
	private runBtn!: HTMLButtonElement;
	private tasksEl!: HTMLElement;
	private taskRows = new Map<number, HTMLElement>();
	private idleEl!: HTMLElement;
	private idleIconEl!: HTMLElement;
	private idleLabelEl!: HTMLElement;
	private idleTextEl!: HTMLElement;
	private idleHintEl!: HTMLElement;
	private idleIconKey = '';
	private listHeadEl!: HTMLElement;
	private listCountEl!: HTMLElement;
	private listHideDelBtn!: HTMLButtonElement;
	private acceptAllBtn!: HTMLButtonElement;
	private ignoreAllBtn!: HTMLButtonElement;
	private listEl!: HTMLElement;
	private rewriteBoxEl!: HTMLElement;
	private rewriteMetaEl!: HTMLElement;
	private rewriteInstructionEl!: HTMLElement;
	private rewriteErrorEl!: HTMLElement;
	private rewriteErrorTextEl!: HTMLElement;
	private rewriteRetryBtn!: HTMLButtonElement;
	private rwHideDelBtn!: HTMLButtonElement;
	private rewriteBodyEl!: HTMLElement;
	private rewriteApplyBtn!: HTMLButtonElement;
	private composerInput!: HTMLTextAreaElement;
	private composerRunBtn!: HTMLButtonElement;
	private statsEl!: HTMLElement;
	private statsRetryBtn!: HTMLButtonElement;
	private hideDel = false;

	constructor(leaf: WorkspaceLeaf, private plugin: ExEditorPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_EX_SIDEBAR;
	}

	getDisplayText(): string {
		return '校对建议';
	}

	getIcon(): string {
		return 'spell-check';
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		// 只在打开时构建一次骨架；此后一切变化走 sync() 的精确更新
		root.empty();
		root.addClass('ex-root');

		// ---- 顶栏：范围 ⌄  强度 ⌄  ……  检查/停止 ----
		const top = root.createDiv({ cls: 'ex-top' });
		this.scopeBtn = top.createEl('button', { cls: 'ex-pick' });
		setTooltip(this.scopeBtn, '检查范围');
		this.scopeBtn.addEventListener('click', () => this.openScopeMenu());
		this.strengthBtn = top.createEl('button', { cls: 'ex-pick' });
		setTooltip(this.strengthBtn, '检查强度');
		this.strengthBtn.addEventListener('click', () => this.openStrengthMenu());
		top.createDiv({ cls: 'ex-top-spacer' });
		this.runBtn = top.createEl('button', { cls: 'mod-cta ex-run' });
		fillButton(this.runBtn, 'play', '检查');
		this.runBtn.addEventListener('click', () => void this.plugin.runCheck(this.checkScope));
		// 取消不占顶栏：检查的取消在任务行（红色 ×），改写的取消在底部发送按钮（原地变红）

		// ---- 中间结果区（滚动）：任务追踪 / 空态 / 列表 ----
		const main = root.createDiv({ cls: 'ex-main' });

		// 任务区：所有进行中的检查任务（跨文件），每行可单独取消
		this.tasksEl = main.createDiv({ cls: 'ex-tasks' });

		this.idleEl = main.createDiv({ cls: 'ex-idle' });
		this.idleIconEl = this.idleEl.createDiv({ cls: 'ex-idle-icon' });
		this.idleLabelEl = this.idleEl.createDiv({ cls: 'ex-idle-label' });
		this.idleTextEl = this.idleEl.createDiv({ cls: 'ex-idle-text' });
		this.idleHintEl = this.idleEl.createDiv({ cls: 'ex-idle-hint' });

		this.listHeadEl = main.createDiv({ cls: 'ex-list-head' });
		this.listCountEl = this.listHeadEl.createDiv({ cls: 'ex-list-count' });
		this.listHideDelBtn = this.listHeadEl.createEl('button', { cls: 'ex-icon-btn' });
		setIcon(this.listHideDelBtn, 'eye-off');
		setTooltip(this.listHideDelBtn, '隐藏删除的文字（替换处显示为琥珀色）');
		this.listHideDelBtn.addEventListener('click', () => this.toggleHideDel());
		this.acceptAllBtn = this.listHeadEl.createEl('button', { cls: 'ex-small ex-accept' });
		fillButton(this.acceptAllBtn, 'check-check', '全部接受');
		this.acceptAllBtn.addEventListener('click', () => void this.plugin.suggestions.acceptAll());
		this.ignoreAllBtn = this.listHeadEl.createEl('button', { cls: 'ex-small' });
		fillButton(this.ignoreAllBtn, 'x', '全部忽略');
		this.ignoreAllBtn.addEventListener('click', () => this.plugin.suggestions.ignoreAll());
		this.listEl = main.createDiv({ cls: 'ex-list' });

		// ---- 底部固定区：改写预览（贴在输入框上方）+ 指令输入 + 用量 ----
		const dock = root.createDiv({ cls: 'ex-dock' });

		this.rewriteBoxEl = dock.createDiv({ cls: 'ex-rewrite' });
		const rewriteToolbar = this.rewriteBoxEl.createDiv({ cls: 'ex-rewrite-toolbar' });
		const rewriteTitle = rewriteToolbar.createDiv({ cls: 'ex-rewrite-title' });
		fillButton(rewriteTitle, 'wand-2', '改写预览');
		const rewriteActions = rewriteToolbar.createDiv({ cls: 'ex-rewrite-actions' });
		this.rwHideDelBtn = rewriteActions.createEl('button', { cls: 'ex-icon-btn' });
		setIcon(this.rwHideDelBtn, 'eye-off');
		setTooltip(this.rwHideDelBtn, '隐藏删除的文字（替换处显示为琥珀色）');
		this.rwHideDelBtn.addEventListener('click', () => this.toggleHideDel());
		this.rewriteApplyBtn = rewriteActions.createEl('button', { cls: 'ex-small mod-cta' });
		fillButton(this.rewriteApplyBtn, 'check', '应用');
		this.rewriteApplyBtn.addEventListener('click', () => void this.plugin.rewriter.applyPreview());
		const rewriteDiscard = rewriteActions.createEl('button', { cls: 'ex-small' });
		fillButton(rewriteDiscard, 'x', '放弃');
		rewriteDiscard.addEventListener('click', () => {
			const ctx = this.plugin.resolver.resolve();
			if (ctx) this.plugin.rewriter.discardPreview(ctx.file.path);
		});
		// 状态行：改写中显示生成进度，完成显示统计，失败切错误行
		this.rewriteMetaEl = this.rewriteBoxEl.createDiv({ cls: 'ex-rewrite-meta' });
		this.rewriteInstructionEl = this.rewriteBoxEl.createDiv({ cls: 'ex-hint' });
		this.rewriteErrorEl = this.rewriteBoxEl.createDiv({ cls: 'ex-rewrite-error ex-hidden' });
		this.rewriteErrorTextEl = this.rewriteErrorEl.createSpan({ cls: 'ex-rewrite-error-text' });
		this.rewriteRetryBtn = this.rewriteErrorEl.createEl('button', { cls: 'ex-small' });
		fillButton(this.rewriteRetryBtn, 'rotate-ccw', '重试');
		this.rewriteRetryBtn.addEventListener('click', () => {
			const ctx = this.plugin.resolver.resolve();
			const p = ctx && this.plugin.rewriter.getPreview(ctx.file.path);
			if (p) void this.plugin.rewriter.run(p.instruction);
		});
		this.rewriteBodyEl = this.rewriteBoxEl.createDiv({ cls: 'ex-rewrite-body' });

		// 聊天式输入框：发送按钮嵌在框内，常驻可见，无内容时置灰
		const composer = dock.createDiv({ cls: 'ex-composer' });
		this.composerInput = composer.createEl('textarea', { cls: 'ex-composer-input' });
		this.composerInput.placeholder = '输入改写要求，改写选中或当前段落…';
		this.composerInput.rows = 1;
		this.composerInput.addEventListener('input', () => {
			this.instructionText = this.composerInput.value;
			this.autoGrowComposer();
			this.sync();
		});
		this.composerRunBtn = composer.createEl('button', { cls: 'clickable-icon ex-send' });
		setIcon(this.composerRunBtn, 'send-horizontal');
		setTooltip(this.composerRunBtn, '运行改写');
		this.composerRunBtn.addEventListener('click', () => {
			// 双角色：改写运行中 = 取消；空闲 = 发送（空指令忽略）
			if (this.plugin.rewriter.isRunning()) {
				this.plugin.rewriter.cancelActive();
				return;
			}
			if (!this.instructionText.trim()) {
				return;
			}
			void this.plugin.rewriter.run(this.instructionText);
		});

		const statsRow = dock.createDiv({ cls: 'ex-stats-row' });
		this.statsEl = statsRow.createDiv({ cls: 'ex-stats', text: '' });
		this.statsRetryBtn = statsRow.createEl('button', { cls: 'ex-icon-btn ex-stats-retry ex-hidden' });
		setIcon(this.statsRetryBtn, 'rotate-ccw');
		setTooltip(this.statsRetryBtn, '重试上次失败的检查');
		this.statsRetryBtn.addEventListener('click', () => {
			const ctx = this.plugin.resolver.resolve();
			const s = ctx && this.plugin.checker.getLastSummary(ctx.file.path);
			if (s?.error) void this.plugin.runCheck(s.scope);
		});

		this.unsubscribers.push(
			this.plugin.suggestions.subscribe(() => this.sync()),
			this.plugin.checker.subscribe(() => this.sync()),
			this.plugin.rewriter.subscribe(() => this.sync()),
			this.plugin.resolver.subscribe(() => this.sync()),
		);
		this.sync();
	}

	async onClose(): Promise<void> {
		for (const u of this.unsubscribers) u();
		this.unsubscribers = [];
		this.cards.clear();
	}

	private openScopeMenu(): void {
		const menu = new Menu();
		for (const [value, opt] of Object.entries(SCOPE_OPTIONS) as [CheckScope, { label: string; icon: string }][]) {
			menu.addItem((item) =>
				item
					.setTitle(opt.label)
					.setIcon(opt.icon)
					.setChecked(this.checkScope === value)
					.onClick(() => {
						this.checkScope = value;
						this.sync();
					}),
			);
		}
		this.showMenuBelow(menu, this.scopeBtn);
	}

	private openStrengthMenu(): void {
		const menu = new Menu();
		for (const [value, label] of Object.entries(STRENGTH_LABELS) as [CheckStrength, string][]) {
			menu.addItem((item) =>
				item
					.setTitle(label)
					.setIcon(STRENGTH_ICONS[value])
					.setChecked(this.plugin.settings.checkStrength === value)
					.onClick(() => {
						this.plugin.settings.checkStrength = value;
						void this.plugin.saveSettings();
						this.sync();
					}),
			);
		}
		this.showMenuBelow(menu, this.strengthBtn);
	}

	private showMenuBelow(menu: Menu, anchor: HTMLElement): void {
		const rect = anchor.getBoundingClientRect();
		menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
	}

	private autoGrowComposer(): void {
		this.composerInput.setCssStyles({ height: 'auto' });
		this.composerInput.setCssStyles({ height: `${Math.min(this.composerInput.scrollHeight, 140)}px` });
	}

	/** 下拉按钮：图标 + 当前值 + 下箭头（值不变时不重建） */
	private setPickLabel(btn: HTMLButtonElement, icon: string, label: string): void {
		const key = `${icon}|${label}`;
		if (btn.dataset.exLabel === key) return;
		btn.dataset.exLabel = key;
		fillButton(btn, icon, label);
		setIcon(btn.createSpan({ cls: 'ex-pick-chevron' }), 'chevron-down');
	}

	/** 精确同步可见卡片：按 id 增删、按状态原地更新、按位置重排序 */
	private sync(): void {
		if (!this.listEl) return;
		const ctx = this.plugin.resolver.resolve();
		const activePath = ctx?.file.path;
		const entries = (ctx ? this.plugin.suggestions.entries(ctx.file.path) : []).filter(
			(e) => e.suggestion.status === 'pending' || e.suggestion.status === 'stale',
		);

		// 1. 移除不再可见的卡片（高度塌缩动画，其余卡片平滑上移）
		const visibleIds = new Set(entries.map((e) => e.suggestion.id));
		for (const [id, el] of this.cards) {
			if (!visibleIds.has(id)) {
				this.cards.delete(id);
				this.animateCardOut(el);
			}
		}

		// 2. 新建缺失的卡片，并把全部卡片按顺序放到位（insertBefore 移动既有节点）
		let anchor: ChildNode | null = this.listEl.firstChild;
		for (const entry of entries) {
			const id = entry.suggestion.id;
			let el = this.cards.get(id);
			if (!el) {
				el = renderSuggestionCard(entry, {
					onAccept: () => this.plugin.suggestions.accept(id),
					onIgnore: () => this.plugin.suggestions.ignore(id),
					onReveal: () => this.plugin.suggestions.reveal(id),
				});
				this.cards.set(id, el);
			} else {
				updateCardState(el, entry.suggestion.status);
			}
			if (el !== anchor) this.listEl.insertBefore(el, anchor);
			anchor = el.nextSibling;
		}
		// 新入列的卡片做高度展开进场（插入后才知道自然高度）
		for (const entry of entries) {
			const el = this.cards.get(entry.suggestion.id);
			if (el && !el.dataset.exEntered) {
				el.dataset.exEntered = '1';
				this.animateCardIn(el);
			}
		}

		// 3. 顶栏：「检查」常驻发送态（运行中再点 = 追加并行任务，取消在任务行）；
		// 下拉不禁用——并行检查各自的范围在发起时快照，互不影响
		const activeTaskList = this.plugin.checker.activeRuns();
		const running = activeTaskList.some((r) => r.path === activePath);
		const rewriting = activePath !== undefined && this.plugin.rewriter.isRunning(activePath);
		const pending = entries.filter((e) => e.suggestion.status === 'pending').length;
		const scopeOpt = SCOPE_OPTIONS[this.checkScope];
		this.setPickLabel(this.scopeBtn, scopeOpt.icon, scopeOpt.label);
		const strength = this.plugin.settings.checkStrength;
		this.setPickLabel(this.strengthBtn, STRENGTH_ICONS[strength], STRENGTH_LABELS[strength]);
		this.runBtn.disabled = !ctx;

		// 4. 任务区：全部进行中任务（跨文件可追踪），按 id 精确增删改
		this.syncTasks(activeTaskList, activePath);

		// 5. 空态：没文档 → 引导打开；有文档且没结果 → 预览将检查的范围
		const preview = running || entries.length > 0 ? null : this.plugin.checker.previewScope(this.checkScope);
		this.idleEl.classList.toggle('ex-hidden', !!ctx && !preview);
		if (!ctx) {
			this.setIdleIcon('file-search');
			this.idleLabelEl.textContent = '打开一篇文档开始校对';
			this.idleTextEl.textContent = '';
			this.idleHintEl.textContent = '';
		} else if (preview) {
			this.setIdleIcon(scopeOpt.icon);
			if (preview.chars > 0) {
				this.idleLabelEl.textContent = `将检查${preview.label} · ${preview.chars} 字`;
				this.idleTextEl.textContent = truncate(preview.text.trim(), SCOPE_PREVIEW_CHARS);
				this.idleHintEl.textContent = '点右上角「检查」开始';
			} else {
				// 选中范围但没选内容：给出提示，不替用户做决定
				this.idleLabelEl.textContent = preview.label;
				this.idleTextEl.textContent = '';
				this.idleHintEl.textContent = preview.text;
			}
		}
		this.idleTextEl.classList.toggle('ex-hidden', !this.idleTextEl.textContent);

		// 6. 列表头、改写预览、指令输入与用量
		this.listHeadEl.classList.toggle('ex-hidden', entries.length === 0);
		this.listCountEl.textContent = `${pending} 条建议`;
		this.acceptAllBtn.disabled = pending === 0;
		setTooltip(this.acceptAllBtn, `接受全部 ${pending} 条（一次 Ctrl+Z 可撤销）`);
		setTooltip(this.ignoreAllBtn, `忽略全部 ${entries.length} 条`);

		this.syncRewritePanel(activePath);

		this.setComposerMode(rewriting ? 'cancel' : 'send');
		if (!rewriting) {
			this.composerRunBtn.disabled = !this.instructionText.trim();
		}

		// 7. 用量行：失败常驻错误与重试入口；成功/无数据则显示用量
		const summary = activePath ? this.plugin.checker.getLastSummary(activePath) : null;
		if (summary?.error && !(running || rewriting)) {
			this.statsEl.textContent = `检查失败 — ${summary.error}`;
			this.statsEl.addClass('is-error');
			this.statsRetryBtn.classList.remove('ex-hidden');
		} else {
			this.statsEl.textContent = running ? '' : this.summaryText(activePath);
			this.statsEl.removeClass('is-error');
			this.statsRetryBtn.classList.add('ex-hidden');
		}
	}

	private setIdleIcon(icon: string): void {
		if (this.idleIconKey === icon) return;
		this.idleIconKey = icon;
		setIcon(this.idleIconEl, icon);
	}

	/** 底部发送按钮双角色：空闲 = 发送（空指令置灰），改写运行中 = 红色取消 */
	private setComposerMode(mode: 'send' | 'cancel'): void {
		if (this.composerRunBtn.dataset.exMode === mode) return;
		this.composerRunBtn.dataset.exMode = mode;
		if (mode === 'cancel') {
			setIcon(this.composerRunBtn, 'square');
			setTooltip(this.composerRunBtn, '取消改写');
			this.composerRunBtn.addClass('ex-cancel');
			this.composerRunBtn.classList.remove('is-busy');
			this.composerRunBtn.disabled = false;
		} else {
			setIcon(this.composerRunBtn, 'send-horizontal');
			setTooltip(this.composerRunBtn, '运行改写');
			this.composerRunBtn.removeClass('ex-cancel');
		}
	}

	/** 切换「隐藏删除文字」：作用于建议卡片与改写预览的全部 diff 标记 */
	private toggleHideDel(): void {		this.hideDel = !this.hideDel;
		this.contentEl.classList.toggle('ex-hide-del', this.hideDel);
		const icon = this.hideDel ? 'eye' : 'eye-off';
		const tip = this.hideDel ? '显示删除的文字' : '隐藏删除的文字（替换处显示为琥珀色）';
		for (const btn of [this.listHideDelBtn, this.rwHideDelBtn]) {
			setIcon(btn, icon);
			setTooltip(btn, tip);
		}
	}

	/** 任务区：按 run.id 精确增删改（复用行节点，不整列重建） */
	private syncTasks(runs: ActiveRun[], activePath?: string): void {
		this.tasksEl.classList.toggle('ex-hidden', runs.length === 0);
		const visible = new Set(runs.map((r) => r.id));
		for (const [id, el] of this.taskRows) {
			if (!visible.has(id)) {
				this.taskRows.delete(id);
				el.remove();
			}
		}
		for (const run of runs) {
			let row = this.taskRows.get(run.id);
			if (!row) {
				row = this.buildTaskRow(run);
				this.taskRows.set(run.id, row);
			}
			this.updateTaskRow(row, run, activePath);
		}
		// 保序：只在顺序错位时移动节点。无条件 appendChild 会先移除再插回节点，
		// 行内 CSS 动画（不定进度条）随之重启——高频 emit 下进度条永远停在起点抖动
		let anchor: ChildNode | null = this.tasksEl.firstChild;
		for (const run of runs) {
			const row = this.taskRows.get(run.id);
			if (!row) continue;
			if (row !== anchor) this.tasksEl.insertBefore(row, anchor);
			anchor = row.nextSibling;
		}
	}

	private buildTaskRow(run: ActiveRun): HTMLElement {
		const row = createDiv({ cls: 'ex-task' });
		const icon = row.createSpan({ cls: 'ex-task-icon' });
		setIcon(icon, SCOPE_OPTIONS[run.scope].icon);
		const info = row.createDiv({ cls: 'ex-task-info' });
		info.createDiv({ cls: 'ex-task-title' });
		const track = info.createDiv({ cls: 'ex-task-track' });
		track.createDiv({ cls: 'ex-task-bar' });
		info.createDiv({ cls: 'ex-task-text' });
		const cancel = row.createEl('button', { cls: 'ex-icon-btn ex-task-cancel' });
		setIcon(cancel, 'x');
		setTooltip(cancel, '取消此任务');
		cancel.addEventListener('click', () => this.plugin.checker.cancelRun(run.id));
		return row;
	}

	/** 行内文本只在变化时写入（进度 120ms 高频更新下避免无谓重排） */
	private updateTaskRow(row: HTMLElement, run: ActiveRun, activePath?: string): void {
		const opt = SCOPE_OPTIONS[run.scope];
		const fileLabel = run.path === activePath ? '' : ` · ${run.path.split('/').pop() ?? run.path}`;
		const setText = (sel: string, text: string): void => {
			const el = row.querySelector<HTMLElement>(sel);
			if (el && el.textContent !== text) el.textContent = text;
		};
		setText('.ex-task-title', `${opt.label}${fileLabel}`);
		const p = run.progress;
		const determinate = p.batchTotal > 1;
		row.querySelector('.ex-task-track')?.classList.toggle('is-indeterminate', !determinate);
		const bar = row.querySelector<HTMLElement>('.ex-task-bar');
		if (bar) {
			const width = determinate ? `${Math.round((p.batchIndex / p.batchTotal) * 100)}%` : '';
			if (bar.style.width !== width) bar.style.width = width;
		}
		setText('.ex-task-text', this.progressText(p));
	}

	/** 改写面板：发起即出现（等待期显示状态），输出后实时 diff，失败显示错误与重试 */
	private syncRewritePanel(activePath: string | undefined): void {
		const preview = activePath ? this.plugin.rewriter.getPreview(activePath) : null;
		this.rewriteBoxEl.classList.toggle('ex-hidden', !preview);
		if (!preview) {
			this.lastPreviewKey = '';
			return;
		}
		this.rewriteInstructionEl.textContent = `指令：${preview.instruction}`;
		this.rewriteApplyBtn.disabled = preview.streaming || !!preview.error;

		this.rewriteErrorEl.classList.toggle('ex-hidden', !preview.error);
		if (preview.error) this.rewriteErrorTextEl.textContent = preview.error;

		if (preview.streaming) {
			// 状态与检查任务行同口径：连接 → 思考中… N 字 → 改写中 · 已生成 N 字
			this.rewriteMetaEl.textContent = preview.rewritten
				? `改写中 · 已生成 ${preview.rewritten.length} 字`
				: preview.reasoningChars > 0
					? `思考中… ${preview.reasoningChars} 字`
					: '正在连接模型…';
			this.renderRewriteStream(preview);
			this.lastPreviewKey = ''; // 完成后需要重建一次最终 diff
		} else if (preview.error) {
			this.rewriteMetaEl.textContent = '';
			// 部分输出按「改写到哪里 diff 到哪里」展示（无光标），否则中断处满屏红
			if (preview.rewritten) this.renderRewriteStream(preview, false);
			else this.rewriteBodyEl.textContent = '';
			this.lastPreviewKey = '';
		} else {
			this.rewriteMetaEl.textContent = `完成 · 共 ${preview.rewritten.length} 字`;
			if (this.lastPreviewKey !== `${preview.startedAt}`) {
				this.renderRewriteDiff(preview);
				this.lastPreviewKey = `${preview.startedAt}`;
			}
		}
	}

	/**
	 * 流式渲染：输出到哪里 diff 到哪里。
	 * 对「全文原文 vs 已输出」做完整 diff 后，截掉尾部尚未改写到的原文（连续 del
	 * 及其间的空白分隔），随输出增长 diff 逐句向前推进。
	 * 尚无输出时不渲染 diff——original vs 空串会把原文全部标成删除（满江红）。
	 */
	private renderRewriteStream(preview: RewritePreview, showCaret = true): void {
		const body = this.rewriteBodyEl;
		if (!preview.rewritten) {
			body.textContent = '';
			if (showCaret) body.createSpan({ cls: 'ex-stream-caret' });
			return;
		}
		const stick = body.scrollTop + body.clientHeight >= body.scrollHeight - 12;
		const prevTop = body.scrollTop;
		body.empty();
		const blocks = trimTrailingDeletions(
			diffTexts(preview.original, preview.rewritten).slice(0, MAX_DIFF_BLOCKS),
		);
		this.renderDiffBlocks(blocks);
		if (showCaret) body.createSpan({ cls: 'ex-stream-caret' });
		body.scrollTop = stick ? body.scrollHeight : prevTop;
	}

	private renderRewriteDiff(preview: RewritePreview): void {
		const body = this.rewriteBodyEl;
		// 重渲染：原本贴底则跟随到底，否则保持当前阅读位置
		const stick = body.scrollTop + body.clientHeight >= body.scrollHeight - 12;
		const prevTop = body.scrollTop;
		body.empty();
		this.renderDiffBlocks(diffTexts(preview.original, preview.rewritten).slice(0, MAX_DIFF_BLOCKS));
		body.scrollTop = stick ? body.scrollHeight : prevTop;
	}

	private renderDiffBlocks(blocks: DiffBlock[]): void {
		const body = this.rewriteBodyEl;
		for (const block of blocks) {
			const el = body.createDiv({ cls: block.kind === 'same' ? 'ex-rw-same' : 'ex-rw-change' });
			appendSegs(el, block.segments);
		}
	}

	/** 进场：高度从 0 展开 + 淡入，后续卡片平滑下移 */
	private animateCardIn(el: HTMLElement): void {
		el.addClass('ex-card-anim');
		el.setCssStyles({ overflow: 'hidden', height: '0px', opacity: '0' });
		void el.offsetHeight; // 强制回流，让起始态先生效
		el.setCssStyles({ height: `${el.scrollHeight}px`, opacity: '1' });
		window.setTimeout(() => {
			el.removeClass('ex-card-anim');
			el.setCssStyles({ height: '', overflow: '', opacity: '' });
		}, ENTER_MS);
	}

	/** 离场：高度塌缩到 0 + 淡出，其余卡片平滑补位 */
	private animateCardOut(el: HTMLElement): void {
		if (el.dataset.exLeaving) return;
		el.dataset.exLeaving = '1';
		el.setCssStyles({ overflow: 'hidden', height: `${el.offsetHeight}px` });
		void el.offsetHeight;
		el.addClass('ex-card-anim');
		el.setCssStyles({ height: '0px', opacity: '0', pointerEvents: 'none' });
		window.setTimeout(() => el.remove(), LEAVE_MS);
	}

	/** 检查进行中的状态文字（进度区内） */
	private progressText(p: RunProgress): string {
		let text = p.batchTotal > 1 ? `第 ${p.batchIndex}/${p.batchTotal} 批` : '逐句分析中';
		if (p.phase === 'thinking') {
			text += p.reasoningChars > 0 ? ` · 思考中… ${p.reasoningChars} 字` : ' · 思考中…';
		} else {
			text += ` · 已收 ${p.suggestionsSoFar} 条`;
		}
		return text;
	}

	/** 底部用量行：常驻最近一次用量与费用（按文件） */
	private summaryText(activePath?: string): string {
		if (activePath === undefined) return '';
		const s = this.plugin.checker.getLastSummary(activePath);
		if (!s || (s.promptTokens === 0 && s.completionTokens === 0 && !s.reasoningTokens)) return '';
		const parts: string[] = [];
		if (typeof s.reasoningTokens === 'number' && s.reasoningTokens > 0) {
			parts.push(`思考 ${fmtTokens(s.reasoningTokens)} tok`);
		}
		const total = s.promptTokens + s.completionTokens;
		if (total > 0) parts.push(`共 ${fmtTokens(total)} tok`);
		if (s.durationMs > 0) parts.push(fmtDuration(s.durationMs));
		if (s.batches > 1) parts.push(`${s.batches} 批`);
		if (typeof s.costYuan === 'number' && s.costYuan > 0) parts.push(`≈ ${formatYuan(s.costYuan)}`);
		const session = this.plugin.checker.getSessionCostYuan();
		if (session > 0) parts.push(`累计 ${formatYuan(session)}`);
		return parts.join(' · ');
	}
}
