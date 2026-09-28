import { describe, expect, it } from 'vitest';
import { appendLocated } from '../src/core/append';
import type { Suggestion, SuggestionEntry } from '../src/types';

function entry(id: string, original: string, from: number, to: number): SuggestionEntry {
	const suggestion: Suggestion = {
		id,
		original,
		replacement: '改',
		category: 'typo',
		severity: 'certain',
		explanation: '',
		status: 'pending',
		source: 'paragraph',
		createdAt: 1,
	};
	return { suggestion, from, to };
}

describe('appendLocated', () => {
	it('新建议追加并按位置排序', () => {
		const out = appendLocated([entry('a', '甲', 10, 11)], [
			{ suggestion: entry('b', '乙', 3, 4).suggestion, from: 3, to: 4 },
		]);
		expect(out.map((e) => e.suggestion.id)).toEqual(['b', 'a']);
	});

	it('original 重复时不重复入列', () => {
		const out = appendLocated([entry('a', '错吴', 5, 7)], [
			{ suggestion: entry('b', '错吴', 5, 7).suggestion, from: 5, to: 7 },
			{ suggestion: entry('c', '另个', 9, 11).suggestion, from: 9, to: 11 },
		]);
		expect(out.map((e) => e.suggestion.id)).toEqual(['a', 'c']);
	});

	it('同批内重复也去重', () => {
		const out = appendLocated([], [
			{ suggestion: entry('a', '重复', 0, 2).suggestion, from: 0, to: 2 },
			{ suggestion: entry('b', '重复', 0, 2).suggestion, from: 0, to: 2 },
		]);
		expect(out).toHaveLength(1);
	});

	it('空追加不改变现有顺序', () => {
		const existing = [entry('a', '甲', 10, 11), entry('b', '乙', 3, 4)];
		expect(appendLocated(existing, [])).toEqual(existing);
	});
});
