import { describe, expect, it } from 'vitest';
import { findProtectedRanges } from '../src/core/protected';
import { relocateSuggestions, sanitizeIssue, uniqueOccurrence, validateAndLocate } from '../src/core/validate';
import type { Suggestion } from '../src/types';

const DOC = '今天天气很好。\n我们去了公园里散步。\n回来的时候买了一杯奶茶。\n';

describe('sanitizeIssue', () => {
	it('清洗合法字段', () => {
		const out = sanitizeIssue({
			original: '公园里散步',
			replacement: '在公园里散步',
			category: 'grammar',
			severity: 'certain',
			explanation: '缺少介词',
		});
		expect(out).not.toBeNull();
		expect(out?.category).toBe('grammar');
	});

	it('非法类别回退为 wording，非法级别回退为 probable', () => {
		const out = sanitizeIssue({ original: 'a', replacement: 'b', category: '别的', severity: '超高' });
		expect(out?.category).toBe('wording');
		expect(out?.severity).toBe('probable');
	});

	it('空原文 / 原文等于替换 / 超长 都拒绝', () => {
		expect(sanitizeIssue({ original: '', replacement: 'b' })).toBeNull();
		expect(sanitizeIssue({ original: 'x', replacement: 'x' })).toBeNull();
		expect(sanitizeIssue({ original: '长'.repeat(501), replacement: 'b' })).toBeNull();
	});
});

describe('uniqueOccurrence', () => {
	it('唯一出现返回位置', () => {
		expect(uniqueOccurrence('公园', DOC, 0, DOC.length, [])).toBe(DOC.indexOf('公园'));
	});

	it('多次出现返回 null', () => {
		const text = '很好。真的很好。';
		expect(uniqueOccurrence('很好', text, 0, text.length, [])).toBeNull();
	});

	it('保护范围内出现不计入', () => {
		const text = '正常文字 `代码很好` 结尾';
		const ranges = findProtectedRanges(text);
		expect(uniqueOccurrence('很好', text, 0, text.length, ranges)).toBeNull();
	});

	it('只搜索指定范围', () => {
		// 第二处唯一出现在范围内时仍可定位
		const text = 'AAA BBB AAA';
		expect(uniqueOccurrence('AAA', text, 4, text.length, [])).toBe(8);
	});
});

describe('validateAndLocate', () => {
	it('定位成功并生成 pending 建议', () => {
		const out = validateAndLocate(
			[{ original: '公园里散步', replacement: '在公园里散步', category: 'grammar', severity: 'certain', explanation: '缺介词' }],
			DOC,
			0,
			DOC.length,
			[],
			'full',
		);
		expect(out.accepted).toHaveLength(1);
		expect(out.droppedCount).toBe(0);
		expect(DOC.slice(out.accepted[0]?.from ?? -1, out.accepted[0]?.to ?? -1)).toBe('公园里散步');
		expect(out.accepted[0]?.suggestion.status).toBe('pending');
	});

	it('原文重复出现时丢弃', () => {
		const text = '他很好，她很好。';
		const out = validateAndLocate(
			[{ original: '很好', replacement: '不错', category: 'wording', severity: 'probable' }],
			text,
			0,
			text.length,
			[],
		);
		expect(out.accepted).toHaveLength(0);
		expect(out.droppedCount).toBe(1);
	});

	it('相互重叠的建议保留先出现的', () => {
		const out = validateAndLocate(
			[
				{ original: '去了公园里', replacement: '到公园', category: 'grammar', severity: 'certain' },
				{ original: '公园里散步', replacement: '在公园里散步', category: 'grammar', severity: 'certain' },
			],
			DOC,
			0,
			DOC.length,
			[],
		);
		expect(out.accepted).toHaveLength(1);
		expect(out.droppedCount).toBe(1);
	});

	it('落在保护范围内的建议被丢弃', () => {
		const text = '正常一句话。`let x = 错吴`';
		const ranges = findProtectedRanges(text);
		const out = validateAndLocate(
			[{ original: '错吴', replacement: '错误', category: 'typo', severity: 'certain' }],
			text,
			0,
			text.length,
			ranges,
		);
		expect(out.accepted).toHaveLength(0);
		expect(out.droppedCount).toBe(1);
	});
});

describe('relocateSuggestions', () => {
	const sug = (id: string, original: string): Suggestion => ({
		id,
		original,
		replacement: 'x',
		category: 'typo',
		severity: 'certain',
		explanation: '',
		status: 'pending',
		source: 'full',
		createdAt: 1,
	});

	it('能重新定位的建议返回位置', () => {
		const out = relocateSuggestions([sug('a', '公园')], DOC, []);
		expect(out.marks).toHaveLength(1);
		expect(out.staleIds).toHaveLength(0);
	});

	it('找不到原文的标记为 stale', () => {
		const out = relocateSuggestions([sug('a', '不存在的句子')], DOC, []);
		expect(out.marks).toHaveLength(0);
		expect(out.staleIds).toEqual(['a']);
	});
});
