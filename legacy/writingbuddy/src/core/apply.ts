import { ChangeSet, StateEffect } from '@codemirror/state';
import { setFindings } from '../editor/findingsField';
import type { FindingRange } from '../editor/findingsField';

/** 一处待应用的替换 */
export interface AcceptEdit {
  id: string;
  from: number;
  to: number;
  insert: string;
}

export interface DispatchSpec {
  changes: { from: number; to: number; insert: string }[];
  effects: StateEffect<FindingRange[]>;
  userEvent: string;
  scrollIntoView: false;
}

/**
 * 计算一次「多选区替换」的事务规格：
 * - 替换按位置从右到左应用，保证左侧偏移不失效
 * - 其余未接受的标记位置通过 ChangeSet 映射到新文档
 * 纯函数（可单测）：不直接持有 EditorView。
 */
export function planBatchEdit(
  docLength: number,
  currentMarks: FindingRange[],
  edits: AcceptEdit[],
): DispatchSpec {
  const spec = [...edits].sort((a, b) => b.from - a.from).map((e) => ({
    from: e.from,
    to: e.to,
    insert: e.insert,
  }));
  const removed = new Set(edits.map((e) => e.id));
  const cs = ChangeSet.of(spec, docLength);
  const remaining: FindingRange[] = currentMarks
    .filter((m) => !removed.has(m.id))
    .map((m) => ({
      from: cs.mapPos(m.from),
      to: cs.mapPos(m.to),
      id: m.id,
      category: m.category,
    }))
    .filter((m) => m.to > m.from);
  return {
    changes: spec,
    effects: setFindings.of(remaining),
    userEvent: 'wb.accept',
    scrollIntoView: false,
  };
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
