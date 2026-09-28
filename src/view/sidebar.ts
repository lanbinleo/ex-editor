import { ItemView, setIcon } from 'obsidian';
import type { WorkspaceLeaf } from 'obsidian';
import type ExEditorPlugin from '../main';
import type { CheckScope } from '../controller/checkController';
import { formatYuan } from '../llm/pricing';
import { truncate } from '../util';
import { renderSuggestionCard, updateCardState } from './card';

export const VIEW_TYPE_EX_SIDEBAR = 'exeditor-sidebar';

/** 卡片进/离场动画时长（与 CSS 保持一致） */
const ENTER_MS = 200;
const LEAVE_MS = 220;
/** 范围预览的最大字符数 */
const SCOPE_PREVIEW_CHARS = 160;

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
 * 侧边栏：建议列表。
 * 架构红线：卡片按条目 id 精确增删改（复用 DOM 节点、保留焦点与滚动），
 * 绝不做 root.empty() 式整体重渲染——这是旧版插件的核心病灶。
 */
export class ExSidebarView extends ItemView {
	private cards = new Map<string, HTMLElement>();
	private unsubscribers: (() => void)[] = [];
	private checkScope: CheckScope = 'paragraph';
	private subtitleEl!: HTMLElement;
	private segButtons: HTMLButtonElement[] = [];
	private runBtn!: HTMLButtonElement;
	private cancelBtn!: HTMLButtonElement;
	private segWrapEl!: HTMLElement;
	private scopeBoxEl!: HTMLElement;
	private scopeLabelEl!: HTMLElement;
	private scopeTextEl!: HTMLElement;
	private emptyEl!: HTMLElement;
	private listEl!: HTMLElement;
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

		const header = root.createDiv({ cls: 'ex-header' });
		const identity = header.createDiv({ cls: 'ex-identity' });
		const iconBox = identity.createDiv({ cls: 'ex-brand-icon' });
		setIcon(iconBox, 'spell-check');
		const identityText = identity.createDiv({ cls: 'ex-identity-text' });
		identityText.createDiv({ cls: 'ex-brand', text: 'ExEditor' });
		this.subtitleEl = identityText.createDiv({ cls: 'ex-subtitle', text: '' });

		const actions = header.createDiv({ cls: 'ex-actions' });
		this.segWrapEl = actions.createDiv({ cls: 'ex-seg' });
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
		this.runBtn = actions.createEl('button', { cls: 'ex-btn ex-btn-check', text: '检查' });
		this.runBtn.addEventListener('click', () => void this.plugin.runCheck(this.checkScope));
		this.cancelBtn = actions.createEl('button', { cls: 'ex-btn ex-btn-cancel', text: '取消' });
		this.cancelBtn.addEventListener('click', () => this.plugin.checker.cancel());

		this.scopeBoxEl = root.createDiv({ cls: 'ex-scope' });
		this.scopeLabelEl = this.scopeBoxEl.createDiv({ cls: 'ex-scope-label' });
		this.scopeTextEl = this.scopeBoxEl.createDiv({ cls: 'ex-scope-text' });

		this.emptyEl = root.createDiv({
			cls: 'ex-empty',
			text: '打开一篇文档，选好范围（段落/选中/全文），点「检查」',
		});
		this.listEl = root.createDiv({ cls: 'ex-list' });
		this.statsEl = root.createDiv({ cls: 'ex-stats', text: '' });

		this.unsubscribers.push(
			this.plugin.suggestions.subscribe(() => this.sync()),
			this.plugin.checker.subscribe(() => this.sync()),
			this.plugin.resolver.subscribe(() => this.sync()),
		);
		this.sync();
	}

	async onClose(): Promise<void> {
		for (const u of this.unsubscribers) u();
		this.unsubscribers = [];
		this.cards.clear();
	}

	/** 精确同步可见卡片：按 id 增删、按状态原地更新、按位置重排序 */
	private sync(): void {
		if (!this.listEl) return;
		const ctx = this.plugin.resolver.resolve();
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

		// 3. 头部操作区：空闲 = 选择 + 检查；运行 = 取消
		const running = this.plugin.checker.isRunning();
		const progress = this.plugin.checker.getProgress();
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
		this.segWrapEl.style.display = running ? 'none' : '';
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

		// 4. 范围预览：显示「现在点检查会查什么」，随选区/文档实时变化
		const preview = running ? null : this.plugin.checker.previewScope(this.checkScope);
		const showScope = !!preview && !!preview.text.trim();
		this.scopeBoxEl.classList.toggle('ex-hidden', !showScope);
		if (showScope && preview) {
			this.scopeLabelEl.textContent = `将检查：${preview.label} · ${preview.chars} 字`;
			this.scopeTextEl.textContent = truncate(preview.text.trim(), SCOPE_PREVIEW_CHARS);
		}

		// 5. 空态与过程信息
		this.emptyEl.style.display = entries.length ? 'none' : '';
		this.statsEl.textContent = this.statsText();
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

	/** 过程信息行：检查中显示进度，完成后常驻最近一次用量与费用 */
	private statsText(): string {
		const p = this.plugin.checker.getProgress();
		if (p) {
			let text = p.batchTotal > 1 ? `全文 ${p.batchIndex}/${p.batchTotal} 批` : '请求中';
			if (p.phase === 'thinking') {
				text += p.reasoningChars > 0 ? ` · 思考中… ${p.reasoningChars} 字` : ' · 思考中…';
			} else {
				text += ` · 已收 ${p.suggestionsSoFar} 条`;
			}
			return text;
		}
		const s = this.plugin.checker.getLastSummary();
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
