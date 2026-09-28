import { CATEGORY_LABELS, SEVERITY_LABELS } from '../types';
import type { Suggestion, SuggestionEntry, SuggestionStatus } from '../types';
import { charDiff } from '../core/diff';
import type { Seg } from '../core/diff';

export interface CardActions {
	onAccept: () => void;
	onIgnore: () => void;
	onReveal: () => void;
}

function appendSegs(parent: HTMLElement, segs: Seg[]): void {
	for (const seg of segs) {
		if (seg.type === 'equal') {
			parent.appendChild(document.createTextNode(seg.text));
		} else {
			parent.createSpan({
				cls: seg.type === 'del' ? 'ex-diff-del' : 'ex-diff-ins',
				text: seg.text,
			});
		}
	}
}

/**
 * 渲染一张建议卡片：正文优先——修改本身用字符级红删绿增标记，元信息退为注释。
 * pending 状态的卡片内容不可变；状态变化（stale）由 updateCardState 原地更新。
 */
export function renderSuggestionCard(entry: SuggestionEntry, actions: CardActions): HTMLElement {
	const sug: Suggestion = entry.suggestion;
	const root = createDiv({ cls: `ex-card ex-cat-${sug.category}` });
	root.dataset.exId = sug.id;

	const meta = root.createDiv({ cls: 'ex-card-meta' });
	meta.createSpan({ cls: 'ex-cat-dot' });
	meta.createSpan({ cls: 'ex-card-cat', text: CATEGORY_LABELS[sug.category] });
	meta.createSpan({ cls: 'ex-card-sep', text: '·' });
	meta.createSpan({ cls: 'ex-card-sev', text: SEVERITY_LABELS[sug.severity] });

	const body = root.createDiv({ cls: 'ex-card-body' });
	appendSegs(body, charDiff(sug.original, sug.replacement));

	if (sug.explanation) {
		root.createDiv({ cls: 'ex-card-expl', text: sug.explanation });
	}

	const note = root.createDiv({
		cls: 'ex-card-note',
		text: '原文已变化，无法定位；可重新检查后再处理',
	});
	note.dataset.role = 'note';

	const actionRow = root.createDiv({ cls: 'ex-card-actions' });
	const mkButton = (label: string, role: string, onClick: () => void): HTMLButtonElement => {
		const btn = actionRow.createEl('button', { cls: 'ex-btn', text: label });
		btn.dataset.role = role;
		btn.addEventListener('click', (e) => {
			e.stopPropagation();
			onClick();
		});
		return btn;
	};
	const accept = mkButton('接受', 'accept', actions.onAccept);
	accept.addClass('ex-btn-accept');
	mkButton('忽略', 'ignore', actions.onIgnore);
	mkButton('定位', 'reveal', actions.onReveal);

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
	for (const role of ['accept', 'reveal']) {
		const btn = root.querySelector<HTMLButtonElement>(`[data-role="${role}"]`);
		if (btn) btn.disabled = stale;
	}
}
