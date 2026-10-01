import { setIcon, setTooltip } from 'obsidian';
import { CATEGORY_LABELS, SEVERITY_LABELS } from '../types';
import type { Suggestion, SuggestionEntry, SuggestionStatus } from '../types';
import { wordDiff } from '../core/diff';
import type { Seg } from '../core/diff';

export interface CardActions {
	onAccept: () => void;
	onIgnore: () => void;
	onReveal: () => void;
}

/** 把 diff 片段渲染进容器：相邻的删除+新增（无论先后）组成一次替换，包进 rep 容器 */
export function appendSegs(parent: HTMLElement, segs: Seg[]): void {
	let i = 0;
	while (i < segs.length) {
		const cur = segs[i];
		const next = segs[i + 1];
		if (cur && next && cur.type !== 'equal' && next.type !== 'equal' && cur.type !== next.type) {
			const rep = parent.createSpan({ cls: 'ex-diff-rep' });
			for (const seg of [cur, next]) {
				rep.createSpan({
					cls: seg.type === 'del' ? 'ex-diff-del' : 'ex-diff-ins',
					text: seg.text,
				});
			}
			i += 2;
			continue;
		}
		if (cur?.type === 'equal') {
			parent.appendChild(document.createTextNode(cur.text));
		} else if (cur) {
			parent.createSpan({
				cls: cur.type === 'del' ? 'ex-diff-del' : 'ex-diff-ins',
				text: cur.text,
			});
		}
		i++;
	}
}

/**
 * 渲染一张建议卡片：正文优先——修改本身用词级红删绿增标记，元信息退为注释。
 * pending 状态的卡片内容不可变；状态变化（stale）由 updateCardState 原地更新。
 */
export function renderSuggestionCard(entry: SuggestionEntry, actions: CardActions): HTMLElement {
	const sug: Suggestion = entry.suggestion;
	const root = createDiv({ cls: `ex-card ex-cat-${sug.category}` });
	root.dataset.exId = sug.id;

	// 元信息行：分类 · 严重度，右侧常驻 ✓ / ✕ 图标按钮（点卡片本身 = 定位）
	const meta = root.createDiv({ cls: 'ex-card-meta' });
	meta.createSpan({ cls: 'ex-cat-dot' });
	meta.createSpan({ cls: 'ex-card-cat', text: CATEGORY_LABELS[sug.category] });
	meta.createSpan({ cls: 'ex-card-sep', text: '·' });
	meta.createSpan({ cls: 'ex-card-sev', text: SEVERITY_LABELS[sug.severity] });
	const actionRow = meta.createDiv({ cls: 'ex-card-actions' });
	const mkButton = (icon: string, tip: string, role: string, onClick: () => void): HTMLButtonElement => {
		const btn = actionRow.createEl('button', { cls: 'ex-icon-btn' });
		setIcon(btn, icon);
		setTooltip(btn, tip);
		btn.dataset.role = role;
		btn.addEventListener('click', (e) => {
			e.stopPropagation();
			onClick();
		});
		return btn;
	};
	mkButton('check', '接受', 'accept', actions.onAccept).addClass('ex-accept');
	mkButton('x', '忽略', 'ignore', actions.onIgnore);

	const body = root.createDiv({ cls: 'ex-card-body' });
	appendSegs(body, wordDiff(sug.original, sug.replacement));

	if (sug.explanation) {
		root.createDiv({ cls: 'ex-card-expl', text: sug.explanation });
	}

	const note = root.createDiv({
		cls: 'ex-card-note',
		text: '原文已变化，无法定位；可重新检查后再处理',
	});
	note.dataset.role = 'note';

	setTooltip(root, '点击定位到原文', { placement: 'left', delay: 600 });
	root.addEventListener('click', () => actions.onReveal());

	updateCardState(root, sug.status);
	return root;
}

/** 原地更新卡片状态（不重建 DOM，保留节点与焦点） */
export function updateCardState(root: HTMLElement, status: SuggestionStatus): void {
	const stale = status === 'stale';
	root.classList.toggle('ex-card-stale', stale);
	const note = root.querySelector<HTMLElement>('[data-role="note"]');
	if (note) note.style.display = stale ? '' : 'none';
	const accept = root.querySelector<HTMLButtonElement>('[data-role="accept"]');
	if (accept) accept.disabled = stale;
}
