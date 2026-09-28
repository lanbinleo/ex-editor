import { describe, expect, it } from 'vitest';
import { splitIntoBatches } from '../src/core/batch';
import type { LineInfo } from '../src/core/batch';

/** 按文档 '第一段第一行\n第一段第二行\n\n第二段第一行\n\n\n第三段' 的 CM6 行结构构造 */
const LINES: LineInfo[] = [
	{ from: 0, to: 6, text: '第一段第一行' },
	{ from: 7, to: 13, text: '第一段第二行' },
	{ from: 14, to: 14, text: '' },
	{ from: 15, to: 21, text: '第二段第一行' },
	{ from: 22, to: 22, text: '' },
	{ from: 23, to: 23, text: '' },
	{ from: 24, to: 27, text: '第三段' },
];

describe('splitIntoBatches', () => {
	it('小文档聚成一批', () => {
		const out = splitIntoBatches(LINES, 3000);
		expect(out).toEqual([{ from: 0, to: 27 }]);
	});

	it('超过 maxChars 时在段落边界分批，超长块单独成批', () => {
		// 块大小：12 / 6 / 3。maxChars=8：12>8 但批为空不切割 → 单独成批；
		// 第二块 6 ≤8；+3=9>8 → 断开；第三块单独
		const out = splitIntoBatches(LINES, 8);
		expect(out).toEqual([
			{ from: 0, to: 13 },
			{ from: 15, to: 21 },
			{ from: 24, to: 27 },
		]);
	});

	it('空行分隔的块不被合并跨越', () => {
		const out = splitIntoBatches(LINES, 13);
		// 第一块 12 字 ≤13；+6 会超 → 断开；第二块 6 + 第三块 3 = 9 ≤13 → 合并
		expect(out).toEqual([
			{ from: 0, to: 13 },
			{ from: 15, to: 27 },
		]);
	});

	it('超长段落块单独成批不切割', () => {
		// 两行之间无空行 → 同一段落块（110 字）超 maxChars 也不切割；
		// 空行后的短块另成一批
		const long: LineInfo[] = [
			{ from: 0, to: 100, text: 'x'.repeat(100) },
			{ from: 101, to: 101, text: '' },
			{ from: 102, to: 111, text: 'y'.repeat(9) },
		];
		const out = splitIntoBatches(long, 50);
		expect(out).toEqual([
			{ from: 0, to: 100 },
			{ from: 102, to: 111 },
		]);
	});

	it('只有空行时返回空数组', () => {
		expect(splitIntoBatches([{ from: 0, to: 0, text: '' }], 100)).toEqual([]);
	});
});
