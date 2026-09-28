import { ItemView, setIcon } from 'obsidian';
import type { WorkspaceLeaf } from 'obsidian';
import type ExEditorPlugin from '../main';
import type { CheckScope } from '../controller/checkController';
import { diffTexts } from '../core/diff';
import { listBackups } from '../storage/backup';
import type { BackupInfo } from '../storage/backup';
import { formatYuan } from '../llm/pricing';
import { STRENGTH_LABELS } from '../types';
import type { CheckStrength, RewritePreview } from '../types';
import { formatClock, truncate } from '../util';
import { renderSuggestionCard, updateCardState } from './card';

export const VIEW_TYPE_EX_SIDEBAR = 'exeditor-sidebar';

/** 卡片进/离场动画时长（与 CSS 保持一致） */
const ENTER_MS = 200;
const LEAVE_MS = 220;
/** 范围预览的最大字符数 */
const SCOPE_PREVIEW_CHARS = 160;
/** 重写预览 diff 块数上限 */
const MAX_DIFF_BLOCKS = 300;

const BACKUP_REASON_LABELS: Record<string, string> = {
	accept: '接受前',
	rewrite: '改写前',
	restore: '恢复前',
	manual: '手动',
	check: '检查前',
	unknown: '快照',
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

/**
 * 侧边栏：建议列表 + 改写预览 + 指令输入 + 快照。
 * 架构红线：建议卡片按条目 id 精确增删改（复用 DOM 节点、保留焦点与滚动），
 * 绝不做 root.empty() 式整体重渲染——这是旧版插件的核心病灶。
 */
export class ExSidebarView extends ItemView {
	private cards = new Map<string, HTMLElement>();
	private unsubscribers: (() => void)[] = [];
	private checkScope: CheckScope = 'paragraph';
	private instructionText = '';
	private lastPreviewKey = '';
	private subtitleEl!: HTMLElement;
	private segButtons: HTMLButtonElement[] = [];
	private strengthButtons: HTMLButtonElement[] = [];
	private runBtn!: HTMLButtonElement;
	private cancelBtn!: HTMLButtonElement;
	private toolbarEl!: HTMLElement;
	private segWrapEl!: HTMLElement;
	private scopeBoxEl!: HTMLElement;
	private scopeLabelEl!: HTMLElement;
	private scopeTextEl!: HTMLElement;
	private rewriteBoxEl!: HTMLElement;
	private rewriteInstructionEl!: HTMLElement;
	private rewriteBodyEl!: HTMLElement;
	private rewriteApplyBtn!: HTMLButtonElement;
	private emptyEl!: HTMLElement;
	private listEl!: HTMLElement;
	private footerEl!: HTMLElement;
	private acceptAllBtn!: HTMLButtonElement;
	private ignoreAllBtn!: HTMLButtonElement;
	private composerInput!: HTMLTextAreaElement;
	private composerRunBtn!: HTMLButtonElement;
	private backupsDetails!: HTMLDetailsElement;
	private backupListEl!: HTMLElement;
	private statsEl!: HTMLElement;

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

		// 头部两行：第一行品牌 + 主动作（检查/取消）；第二行范围与强度两组分段控件
		const header = root.createDiv({ cls: 'ex-header' });
		const identity = header.createDiv({ cls: 'ex-identity' });
		const iconBox = identity.createDiv({ cls: 'ex-brand-icon' });
		setIcon(iconBox, 'spell-check');
		const identityText = identity.createDiv({ cls: 'ex-identity-text' });
		identityText.createDiv({ cls: 'ex-brand', text: 'ExEditor' });
		this.subtitleEl = identityText.createDiv({ cls: 'ex-subtitle', text: '' });

		this.runBtn = header.createEl('button', { cls: 'ex-btn ex-btn-check', text: '检查' });
		this.runBtn.addEventListener('click', () => void this.plugin.runCheck(this.checkScope));
		this.cancelBtn = header.createEl('button', { cls: 'ex-btn ex-btn-cancel', text: '取消' });
		this.cancelBtn.addEventListener('click', () => this.plugin.checker.cancelActive());

		const toolbar = root.createDiv({ cls: 'ex-toolbar' });
		this.toolbarEl = toolbar;
		this.segWrapEl = toolbar.createDiv({ cls: 'ex-seg' });
		for (const [scope, label] of [
			['paragraph', '段落'],
			['selection', '选中'],
			['full', '全文'],
		] as const) {
			const btn = this.segWrapEl.createEl('button', { cls: 'ex-seg-item', text: label });
			btn.addEventListener('click', () => {
				this.checkScope = scope;
				this.sync();
			});
			this.segButtons.push(btn);
		}
		const strengthSeg = toolbar.createDiv({ cls: 'ex-seg' });
		for (const [value, label] of Object.entries(STRENGTH_LABELS)) {
			const btn = strengthSeg.createEl('button', { cls: 'ex-seg-item', text: label });
			btn.dataset.strength = value;
			btn.addEventListener('click', () => {
				this.plugin.settings.checkStrength = value as CheckStrength;
				void this.plugin.saveSettings();
				this.sync();
			});
			this.strengthButtons.push(btn);
		}

		this.scopeBoxEl = root.createDiv({ cls: 'ex-scope' });
		this.scopeLabelEl = this.scopeBoxEl.createDiv({ cls: 'ex-scope-label' });
		this.scopeTextEl = this.scopeBoxEl.createDiv({ cls: 'ex-scope-text' });

		this.rewriteBoxEl = root.createDiv({ cls: 'ex-rewrite' });
		const rewriteToolbar = this.rewriteBoxEl.createDiv({ cls: 'ex-rewrite-toolbar' });
		rewriteToolbar.createSpan({ cls: 'ex-rewrite-title', text: '改写预览' });
		const rewriteActions = rewriteToolbar.createDiv({ cls: 'ex-rewrite-actions' });
		this.rewriteApplyBtn = rewriteActions.createEl('button', {
			cls: 'ex-btn ex-btn-accept',
			text: '应用改写',
		});
		this.rewriteApplyBtn.addEventListener('click', () => void this.plugin.rewriter.applyPreview());
		const rewriteDiscard = rewriteActions.createEl('button', { cls: 'ex-btn', text: '放弃' });
		rewriteDiscard.addEventListener('click', () => {
			const ctx = this.plugin.resolver.resolve();
			if (ctx) this.plugin.rewriter.discardPreview(ctx.file.path);
		});
		this.rewriteInstructionEl = this.rewriteBoxEl.createDiv({ cls: 'ex-hint' });
		this.rewriteBodyEl = this.rewriteBoxEl.createDiv({ cls: 'ex-rewrite-body' });

		this.emptyEl = root.createDiv({
			cls: 'ex-empty',
			text: '打开一篇文档，选好范围与强度，点「检查」',
		});
		this.listEl = root.createDiv({ cls: 'ex-list' });

		this.footerEl = root.createDiv({ cls: 'ex-footer' });
		this.acceptAllBtn = this.footerEl.createEl('button', { cls: 'ex-btn ex-btn-accept', text: '接受全部' });
		this.acceptAllBtn.addEventListener('click', () => void this.plugin.suggestions.acceptAll());
		this.ignoreAllBtn = this.footerEl.createEl('button', { cls: 'ex-btn', text: '忽略全部' });
		this.ignoreAllBtn.addEventListener('click', () => this.plugin.suggestions.ignoreAll());

		// 指令输入：常驻收起为单行，聚焦/有内容时展开运行按钮
		const bottom = root.createDiv({ cls: 'ex-bottom' });
		this.composerInput = bottom.createEl('textarea', { cls: 'ex-composer-input' });
		this.composerInput.placeholder = '输入改写要求，改写选中或当前段落…';
		this.composerInput.rows = 1;
		this.composerInput.addEventListener('input', () => {
			this.instructionText = this.composerInput.value;
			this.autoGrowComposer();
			bottom.classList.toggle('ex-open', !!this.instructionText.trim());
		});
		this.composerInput.addEventListener('focus', () => bottom.addClass('ex-open'));
		this.composerInput.addEventListener('blur', () => {
			if (!this.instructionText.trim()) bottom.removeClass('ex-open');
		});
		const composerFoot = bottom.createDiv({ cls: 'ex-composer-foot' });
		this.composerRunBtn = composerFoot.createEl('button', { cls: 'ex-btn ex-btn-run', text: '运行' });
		this.composerRunBtn.addEventListener('click', () => {
			if (!this.instructionText.trim()) {
				return;
			}
			void this.plugin.rewriter.run(this.instructionText);
		});

		// 快照折叠区：展开时才异步加载列表
		this.backupsDetails = root.createEl('details', { cls: 'ex-backups' });
		this.backupsDetails.createEl('summary', { text: '快照与恢复' });
		this.backupsDetails.addEventListener('toggle', () => {
			if (this.backupsDetails.open) void this.fillBackups();
		});
		this.backupListEl = this.backupsDetails.createDiv({ cls: 'ex-backup-list' });

		this.statsEl = root.createDiv({ cls: 'ex-stats', text: '' });

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

	private autoGrowComposer(): void {
		this.composerInput.setCssStyles({ height: 'auto' });
		this.composerInput.setCssStyles({ height: `${Math.min(this.composerInput.scrollHeight, 140)}px` });
	}

	/** 快照列表（仅在用户展开/手动刷新时重建此折叠区内容） */
	private async fillBackups(): Promise<void> {
		const listEl = this.backupListEl;
		listEl.empty();
		const ctx = this.plugin.resolver.resolve();
		if (!ctx) {
			listEl.createDiv({ cls: 'ex-hint', text: '打开文档后可查看该篇的快照' });
			return;
		}
		const manual = listEl.createEl('button', { cls: 'ex-btn', text: '立即备份当前内容' });
		manual.addEventListener('click', () => void this.backupAndRefresh());
		let backups: BackupInfo[] = [];
		try {
			backups = await listBackups(this.plugin.app, this.plugin.settings.backupDir, ctx.file);
		} catch {
			backups = [];
		}
		if (!backups.length) {
			listEl.createDiv({ cls: 'ex-hint', text: '暂无快照。批量接受与改写应用前会自动备份。' });
			return;
		}
		for (const bp of backups) {
			const row = listEl.createDiv({ cls: 'ex-backup-row' });
			row.createSpan({
				cls: 'ex-backup-time',
				text: `${formatClock(bp.mtime)} · ${BACKUP_REASON_LABELS[bp.reason] ?? '快照'}`,
			});
			const restore = row.createEl('button', { cls: 'ex-btn', text: '恢复' });
			restore.addEventListener('click', () => void this.restoreAndRefresh(bp.path));
		}
	}

	private async backupAndRefresh(): Promise<void> {
		await this.plugin.backupActiveFile();
		await this.fillBackups();
	}

	private async restoreAndRefresh(backupPath: string): Promise<void> {
		await this.plugin.restoreBackup(backupPath);
		await this.fillBackups();
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

		// 3. 头部操作区：空闲 = 选择 + 检查；运行 = 取消（全部按当前文件的状态）
		const running = activePath !== undefined && this.plugin.checker.isRunning(activePath);
		const progress = activePath ? this.plugin.checker.getProgress(activePath) : null;
		const pending = entries.filter((e) => e.suggestion.status === 'pending').length;
		if (progress) {
			const scopeLabel =
				progress.scope === 'full' ? '全文' : progress.scope === 'selection' ? '选区' : '段落';
			this.subtitleEl.textContent =
				progress.batchTotal > 1
					? `${scopeLabel} ${progress.batchIndex}/${progress.batchTotal} 批，逐句分析中…`
					: '逐句分析中，深思考可能需要一两分钟…';
		} else {
			this.subtitleEl.textContent = pending > 0 ? `待处理 ${pending} 条` : '';
		}
		this.toolbarEl.style.display = running ? 'none' : '';
		this.runBtn.style.display = running ? 'none' : '';
		this.cancelBtn.style.display = running ? '' : 'none';
		for (const [i, btn] of this.segButtons.entries()) {
			btn.classList.toggle(
				'is-active',
				(i === 0 && this.checkScope === 'paragraph') ||
					(i === 1 && this.checkScope === 'selection') ||
					(i === 2 && this.checkScope === 'full'),
			);
		}
		for (const btn of this.strengthButtons) {
			btn.classList.toggle('is-active', btn.dataset.strength === this.plugin.settings.checkStrength);
		}

		// 4. 范围预览：只在「还没有结果」时显示；有结果就收起来（结果界面保持干净）
		const preview = running || entries.length > 0 ? null : this.plugin.checker.previewScope(this.checkScope);
		const showScope = !!preview && preview.chars > 0;
		this.scopeBoxEl.classList.toggle('ex-hidden', !showScope && !(preview && preview.chars === 0));
		if (preview && preview.chars > 0) {
			this.scopeLabelEl.textContent = `将检查：${preview.label} · ${preview.chars} 字`;
			this.scopeTextEl.textContent = truncate(preview.text.trim(), SCOPE_PREVIEW_CHARS);
		} else if (preview && preview.chars === 0) {
			// 选中范围但没选内容：给出提示，不替用户做决定
			this.scopeLabelEl.textContent = preview.label;
			this.scopeTextEl.textContent = preview.text;
		}

		this.syncRewritePanel(activePath);

		// 5. 空态（仅未打开文档时）、底栏、指令输入与过程信息
		this.emptyEl.style.display = ctx ? 'none' : '';
		this.footerEl.classList.toggle('ex-hidden', entries.length === 0);
		this.acceptAllBtn.textContent = `接受全部（${pending}）`;
		this.ignoreAllBtn.textContent = `忽略全部（${entries.length}）`;
		const rewriting = activePath !== undefined && this.plugin.rewriter.isRunning(activePath);
		this.composerRunBtn.disabled = rewriting;
		this.composerRunBtn.textContent = rewriting ? '改写中…' : '运行';
		this.statsEl.textContent = this.statsText(activePath);
	}

	/** 改写预览面板：流式期间等首个字到达再显示；完成后渲染 diff */
	private syncRewritePanel(activePath: string | undefined): void {
		const preview = activePath ? this.plugin.rewriter.getPreview(activePath) : null;
		// 空内容流式等待期不显示空卡
		const visible = !!preview && (!!preview.rewritten || !preview.streaming);
		this.rewriteBoxEl.classList.toggle('ex-hidden', !visible);
		if (!preview) {
			this.lastPreviewKey = '';
			return;
		}
		this.rewriteInstructionEl.textContent = `指令：${preview.instruction}`;
		this.rewriteApplyBtn.disabled = preview.streaming;
		if (preview.streaming) {
			this.rewriteBodyEl.textContent = preview.rewritten ? preview.rewritten + '…' : '等待模型输出…';
			this.lastPreviewKey = ''; // 完成后需要重建 diff
		} else if (this.lastPreviewKey !== `${preview.startedAt}`) {
			this.renderRewriteDiff(preview);
			this.lastPreviewKey = `${preview.startedAt}`;
		}
	}

	private renderRewriteDiff(preview: RewritePreview): void {
		const body = this.rewriteBodyEl;
		body.empty();
		const blocks = diffTexts(preview.original, preview.rewritten).slice(0, MAX_DIFF_BLOCKS);
		for (const block of blocks) {
			const el = body.createDiv({ cls: block.kind === 'same' ? 'ex-rw-same' : 'ex-rw-change' });
			for (const seg of block.segments) {
				if (seg.type === 'equal') {
					el.appendChild(document.createTextNode(seg.text));
				} else {
					el.createSpan({
						cls: seg.type === 'del' ? 'ex-diff-del' : 'ex-diff-ins',
						text: seg.text,
					});
				}
			}
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

	/** 过程信息行：检查中显示进度，完成后常驻最近一次用量与费用（按文件） */
	private statsText(activePath?: string): string {
		if (activePath === undefined) return '';
		const p = this.plugin.checker.getProgress(activePath);
		if (p) {
			let text = p.batchTotal > 1 ? `全文 ${p.batchIndex}/${p.batchTotal} 批` : '请求中';
			if (p.phase === 'thinking') {
				text += p.reasoningChars > 0 ? ` · 思考中… ${p.reasoningChars} 字` : ' · 思考中…';
			} else {
				text += ` · 已收 ${p.suggestionsSoFar} 条`;
			}
			return text;
		}
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
