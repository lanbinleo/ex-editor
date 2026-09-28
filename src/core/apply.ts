import { ChangeSet } from '@codemirror/state';

/** 一处待应用的替换 */
export interface AcceptEdit {
	id: string;
	from: number;
	to: number;
	insert: string;
}

/** 一个需要随编辑映射位置的标记（M2 起由编辑器 StateField 持有） */
export interface MarkPos {
	id: string;
	from: number;
	to: number;
}

export interface BatchPlan {
	/** 替换列表，按位置从右到左排列，可直接作为单个事务的 changes */
	changes: { from: number; to: number; insert: string }[];
	/** 其余未被接受、位置已映射到新文档的标记 */
	remaining: MarkPos[];
}

/**
 * 计算一次「多选区替换」的事务规格：
 * - 替换按位置从右到左排列，保证左侧偏移不失效
 * - 其余未接受的标记位置通过 ChangeSet 映射到新文档
 * 纯函数（可单测）：不直接持有 EditorView，也不依赖编辑器扩展。
 */
export function planBatchEdit(docLength: number, currentMarks: MarkPos[], edits: AcceptEdit[]): BatchPlan {
	const changes = [...edits]
		.sort((a, b) => b.from - a.from)
		.map((e) => ({ from: e.from, to: e.to, insert: e.insert }));
	const removed = new Set(edits.map((e) => e.id));
	const cs = ChangeSet.of(changes, docLength);
	const remaining: MarkPos[] = currentMarks
		.filter((m) => !removed.has(m.id))
		.map((m) => ({
			from: cs.mapPos(m.from),
			to: cs.mapPos(m.to),
			id: m.id,
		}))
		.filter((m) => m.to > m.from);
	return { changes, remaining };
}

/** 剔除相互重叠的编辑（保留先出现的），返回清理后的列表 */
export function dropOverlaps(edits: AcceptEdit[]): AcceptEdit[] {
	const sorted = [...edits].sort((a, b) => a.from - b.from);
	const out: AcceptEdit[] = [];
	for (const e of sorted) {
		if (out.some((o) => o.from < e.to && e.from < o.to)) continue;
		out.push(e);
	}
	return out;
}
