import { ItemView, setIcon } from 'obsidian';
import type { WorkspaceLeaf } from 'obsidian';
import type ExEditorPlugin from '../main';
import { renderSuggestionCard, updateCardState } from './card';

export const VIEW_TYPE_EX_SIDEBAR = 'exeditor-sidebar';

/**
 * 侧边栏 v1：建议列表。
 * 架构红线：卡片按条目 id 精确增删改（复用 DOM 节点、保留焦点与滚动），
 * 绝不做 root.empty() 式整体重渲染——这是旧版插件的核心病灶。
 */
export class ExSidebarView extends ItemView {
	private cards = new Map<string, HTMLElement>();
	private unsubscribers: (() => void)[] = [];
	private subtitleEl!: HTMLElement;
	private checkBtn!: HTMLButtonElement;
	private emptyEl!: HTMLElement;
	private listEl!: HTMLElement;

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
		this.checkBtn = header.createEl('button', { cls: 'ex-btn ex-btn-check' });
		this.checkBtn.textContent = '检查本段落';
		this.checkBtn.addEventListener('click', () => void this.plugin.runParagraphCheck());

		this.emptyEl = root.createDiv({
			cls: 'ex-empty',
			text: '打开一篇文档，光标放进段落，运行「检查本段落」',
		});
		this.listEl = root.createDiv({ cls: 'ex-list' });

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

		// 1. 移除不再可见的卡片
		const visibleIds = new Set(entries.map((e) => e.suggestion.id));
		for (const [id, el] of this.cards) {
			if (!visibleIds.has(id)) {
				el.remove();
				this.cards.delete(id);
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

		// 3. 头部与空态
		const running = this.plugin.checker.isRunning();
		const pending = entries.filter((e) => e.suggestion.status === 'pending').length;
		this.subtitleEl.textContent = running
			? '分析中，深思考可能需要一两分钟…'
			: pending > 0
				? `待处理 ${pending} 条`
				: '';
		this.checkBtn.disabled = running;
		this.checkBtn.textContent = running ? '分析中…' : '检查本段落';
		this.emptyEl.style.display = entries.length ? 'none' : '';
	}
}
