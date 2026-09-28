import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import type { TransactionSpec } from '@codemirror/state';
import { collectFindings, findingsField, setFindings } from '../src/editor/findingsField';
import { dropOverlaps, planBatchEdit } from '../src/core/apply';

const DOC = '0123456789';

function applySpec(doc: string, marks: Parameters<typeof setFindings.of>[0], spec: TransactionSpec) {
  let state = EditorState.create({ doc, extensions: [findingsField] });
  state = state.update({ effects: setFindings.of(marks) }).state;
  state = state.update(spec).state;
  return state;
}

describe('planBatchEdit', () => {
  it('从右到左应用并映射其余标记', () => {
    // 标记 A 覆盖 0-2，B 覆盖 4-6；接受 B（替换为更长的文本）
    const marks = [
      { from: 0, to: 2, id: 'a', category: 'typo' as const },
      { from: 4, to: 6, id: 'b', category: 'grammar' as const },
    ];
    const spec = planBatchEdit(DOC.length, marks, [{ id: 'b', from: 4, to: 6, insert: 'XYZW' }]);
    expect(spec.changes).toEqual([{ from: 4, to: 6, insert: 'XYZW' }]);
    const remaining = spec.effects.value;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe('a');
    expect(remaining[0].from).toBe(0);
    expect(remaining[0].to).toBe(2);

    const after = applySpec(DOC, marks, spec as TransactionSpec);
    expect(after.doc.toString()).toBe('0123XYZW6789');
    expect(collectFindings(after)).toEqual([{ from: 0, to: 2, id: 'a', category: 'typo' }]);
  });

  it('多编辑合并为一个事务，左侧偏移随右侧替换平移', () => {
    const marks = [
      { from: 0, to: 1, id: 'a', category: 'typo' as const },
      { from: 8, to: 9, id: 'b', category: 'typo' as const },
      { from: 3, to: 4, id: 'c', category: 'grammar' as const },
    ];
    const spec = planBatchEdit(DOC.length, marks, [
      { id: 'a', from: 0, to: 1, insert: 'AAAA' },
      { id: 'b', from: 8, to: 9, insert: 'B' },
    ]);
    const after = applySpec(DOC, marks, spec as TransactionSpec);
    expect(after.doc.toString()).toBe('AAAA1234567B9');
    const final = collectFindings(after);
    expect(final.map((m) => m.id)).toEqual(['c']);
    // [0,1) 被替换为 4 字符，右侧位置整体 +3
    expect(final[0].from).toBe(6);
    expect(final[0].to).toBe(7);
  });

  it('标记随文档编辑自动映射（StateField 自身能力）', () => {
    let state = EditorState.create({ doc: DOC, extensions: [findingsField] });
    state = state.update({ effects: setFindings.of([{ from: 4, to: 6, id: 'x', category: 'typo' }]) }).state;
    state = state.update({ changes: { from: 0, to: 0, insert: 'AB' } }).state;
    expect(collectFindings(state)[0].from).toBe(6);
  });
});

describe('dropOverlaps', () => {
  it('保留先出现的，剔除与其重叠的', () => {
    const out = dropOverlaps([
      { id: 'a', from: 0, to: 5, insert: 'x' },
      { id: 'b', from: 3, to: 8, insert: 'y' },
      { id: 'c', from: 6, to: 9, insert: 'z' },
    ]);
    expect(out.map((e) => e.id)).toEqual(['a', 'c']);
  });

  it('无重叠全部保留', () => {
    const out = dropOverlaps([
      { id: 'a', from: 0, to: 2, insert: 'x' },
      { id: 'b', from: 4, to: 6, insert: 'y' },
    ]);
    expect(out).toHaveLength(2);
  });
});
