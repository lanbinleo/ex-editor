import type { EditorState } from '@codemirror/state';

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
		// CM6 边界语义：line.to 指向行尾换行符，lineAt(to) 仍返回本行；to+1 才落到下一行
		const next = state.doc.lineAt(to + 1);
		if (next.text.trim() === '') break;
		to = next.to;
	}
	return { from, to };
}
