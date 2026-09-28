import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { dropOverlaps, planBatchEdit } from '../src/core/apply';

const DOC = '0123456789';

describe('planBatchEdit', () => {
	it('从右到左应用并映射其余标记', () => {
		// 标记 A 覆盖 0-2，B 覆盖 4-6；接受 B（替换为更长的文本）
		const marks = [
			{ id: 'a', from: 0, to: 2 },
			{ id: 'b', from: 4, to: 6 },
		];
		const plan = planBatchEdit(DOC.length, marks, [{ id: 'b', from: 4, to: 6, insert: 'XYZW' }]);
		expect(plan.changes).toEqual([{ from: 4, to: 6, insert: 'XYZW' }]);
		expect(plan.remaining).toHaveLength(1);
		expect(plan.remaining[0]?.id).toBe('a');
		expect(plan.remaining[0]?.from).toBe(0);
		expect(plan.remaining[0]?.to).toBe(2);

		// changes 作为单个事务应用后的文档
		const state = EditorState.create({ doc: DOC }).update({ changes: plan.changes }).state;
		expect(state.doc.toString()).toBe('0123XYZW6789');
	});

	it('多编辑合并为一个事务，左侧偏移随右侧替换平移', () => {
		const marks = [
			{ id: 'a', from: 0, to: 1 },
			{ id: 'b', from: 8, to: 9 },
			{ id: 'c', from: 3, to: 4 },
		];
		const plan = planBatchEdit(DOC.length, marks, [
			{ id: 'a', from: 0, to: 1, insert: 'AAAA' },
			{ id: 'b', from: 8, to: 9, insert: 'B' },
		]);
		const state = EditorState.create({ doc: DOC }).update({ changes: plan.changes }).state;
		expect(state.doc.toString()).toBe('AAAA1234567B9');
		const final = plan.remaining;
		expect(final.map((m) => m.id)).toEqual(['c']);
		// [0,1) 被替换为 4 字符，右侧位置整体 +3
		expect(final[0]?.from).toBe(6);
		expect(final[0]?.to).toBe(7);
	});

	it('被替换后长度归零的标记被剔除', () => {
		const marks = [{ id: 'a', from: 2, to: 4 }];
		const plan = planBatchEdit(DOC.length, marks, [{ id: 'x', from: 2, to: 4, insert: '' }]);
		expect(plan.remaining).toHaveLength(0);
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
