import { RangeSet, RangeValue, StateEffect, StateField } from '@codemirror/state';
import type { EditorState } from '@codemirror/state';
import type { Category } from '../types';

/** 存进 RangeSet 的标记值（继承 RangeValue 以获得默认的 side/mapMode 等行为） */
export class FindingMark extends RangeValue {
  constructor(
    readonly id: string,
    readonly category: Category,
  ) {
    super();
  }
  eq(other: RangeValue): boolean {
    return other instanceof FindingMark && other.id === this.id;
  }
}

/** 编辑器内的建议标记（位置随事务自动映射，打字不错位） */
export interface FindingRange {
  from: number;
  to: number;
  id: string;
  category: Category;
}

/** 全量替换当前编辑器中的建议标记 */
export const setFindings = StateEffect.define<FindingRange[]>();
/** 设置/清除当前激活（高亮）的建议 id */
export const setActiveFinding = StateEffect.define<string | null>();

export const findingsField = StateField.define<RangeSet<FindingMark>>({
  create: () => RangeSet.empty,
  update(value, tr) {
    let next = tr.docChanged ? value.map(tr.changes) : value;
    for (const effect of tr.effects) {
      if (effect.is(setFindings)) {
        next = RangeSet.of(
          effect.value
            .filter((r) => r.to > r.from)
            .map((r) => new FindingMark(r.id, r.category).range(r.from, r.to)),
          true,
        );
      }
    }
    return next;
  },
});

export const activeFindingField = StateField.define<string | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setActiveFinding)) return effect.value;
    }
    return value;
  },
});

/** 读取当前编辑器中的全部建议标记（按位置排序） */
export function collectFindings(state: EditorState): FindingRange[] {
  const out: FindingRange[] = [];
  state.field(findingsField).between(0, state.doc.length, (from, to, value) => {
    if (to > from) out.push({ from, to, id: value.id, category: value.category });
  });
  return out.sort((a, b) => a.from - b.from);
}

/** 找到覆盖某位置的标记（悬浮提示 / 右键菜单用） */
export function findMarkAt(state: EditorState, pos: number): FindingRange | null {
  return collectFindings(state).find((m) => m.from <= pos && pos <= m.to) ?? null;
}
