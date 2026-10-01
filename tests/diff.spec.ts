import { describe, expect, it } from 'vitest';
import { diffTexts, wordDiff } from '../src/core/diff';

describe('wordDiff', () => {
	it('完全相同返回单个 equal', () => {
		expect(wordDiff('今天天气很好', '今天天气很好')).toEqual([
			{ type: 'equal', text: '今天天气很好' },
		]);
	});

	it('错别字与正确词分词不对称时整词替换', () => {
		// ICU 把错拼「狠好」切成两个字、正确「很好」切成一个词，LCS 无公共 token，
		// 展示为整词替换（~~狠好~~ 很好）而不是字符碎片
		const segs = wordDiff('今天天气狠好', '今天天气很好');
		expect(segs).toEqual([
			{ type: 'equal', text: '今天天气' },
			{ type: 'del', text: '狠好' },
			{ type: 'ins', text: '很好' },
		]);
	});

	it('英文整词替换不拆成字符碎片', () => {
		expect(wordDiff('because', 'become')).toEqual([
			{ type: 'del', text: 'because' },
			{ type: 'ins', text: 'become' },
		]);
	});

	it('中文按词替换，不混成半个词', () => {
		expect(wordDiff('美丽', '美妙')).toEqual([
			{ type: 'del', text: '美丽' },
			{ type: 'ins', text: '美妙' },
		]);
	});

	it('词级改动前后保留未变的词', () => {
		const segs = wordDiff('我们明天去公园', '我们后天去公园');
		expect(segs).toContainEqual({ type: 'del', text: '明天' });
		expect(segs).toContainEqual({ type: 'ins', text: '后天' });
		expect(segs).toContainEqual({ type: 'equal', text: '我们' });
		expect(segs).toContainEqual({ type: 'equal', text: '去公园' });
	});

	it('片段拼接可还原原文', () => {
		const a = '这篇文章的结构有一点点问题，但是整体不错。';
		const b = '这篇文章的结构有些问题，但整体不错。';
		const segs = wordDiff(a, b);
		expect(segs.filter((s) => s.type !== 'ins').map((s) => s.text).join('')).toBe(a);
		expect(segs.filter((s) => s.type !== 'del').map((s) => s.text).join('')).toBe(b);
	});

	it('空串边界', () => {
		expect(wordDiff('', '新增')).toEqual([{ type: 'ins', text: '新增' }]);
		expect(wordDiff('删除', '')).toEqual([{ type: 'del', text: '删除' }]);
	});
});

describe('diffTexts', () => {
	it('完全相同全是 same 块', () => {
		const blocks = diffTexts('第一行\n第二行', '第一行\n第二行');
		expect(blocks.every((b) => b.kind === 'same')).toBe(true);
		expect(blocks).toHaveLength(2);
	});

	it('修改行生成内嵌词级 diff 的 change 块', () => {
		const blocks = diffTexts('第一行\n旧的第二行\n第三行', '第一行\n新的第二行\n第三行');
		const change = blocks.filter((b) => b.kind === 'change');
		expect(change).toHaveLength(1);
		const segs = change[0]?.segments ?? [];
		expect(segs).toContainEqual({ type: 'del', text: '旧的' });
		expect(segs).toContainEqual({ type: 'ins', text: '新的' });
		// 未变行保持 same
		expect(blocks.filter((b) => b.kind === 'same').map((b) => b.segments[0]?.text)).toEqual([
			'第一行',
			'第三行',
		]);
	});

	it('纯新增行进入 change 块', () => {
		const blocks = diffTexts('第一行', '第一行\n第二行');
		const change = blocks.filter((b) => b.kind === 'change');
		expect(change).toHaveLength(1);
		expect(change[0]?.segments).toEqual([{ type: 'ins', text: '第二行' }]);
	});
});
