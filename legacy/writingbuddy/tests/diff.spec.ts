import { describe, expect, it } from 'vitest';
import { charDiff, diffTexts } from '../src/core/diff';

describe('charDiff', () => {
  it('完全相同返回单个 equal', () => {
    expect(charDiff('今天天气很好', '今天天气很好')).toEqual([
      { type: 'equal', text: '今天天气很好' },
    ]);
  });

  it('识别少量字符改动', () => {
    const segs = charDiff('今天天气狠好', '今天天气很好');
    expect(segs).toContainEqual({ type: 'del', text: '狠' });
    expect(segs).toContainEqual({ type: 'ins', text: '很' });
    expect(segs).toContainEqual({ type: 'equal', text: '今天天气' });
    expect(segs).toContainEqual({ type: 'equal', text: '好' });
  });

  it('片段拼接可还原原文', () => {
    const a = '这篇文章的结构有一点点问题，但是整体不错。';
    const b = '这篇文章的结构有些问题，但整体不错。';
    const segs = charDiff(a, b);
    expect(segs.filter((s) => s.type !== 'ins').map((s) => s.text).join('')).toBe(a);
    expect(segs.filter((s) => s.type !== 'del').map((s) => s.text).join('')).toBe(b);
  });

  it('空串边界', () => {
    expect(charDiff('', '新增')).toEqual([{ type: 'ins', text: '新增' }]);
    expect(charDiff('删除', '')).toEqual([{ type: 'del', text: '删除' }]);
  });
});

describe('diffTexts', () => {
  it('完全相同全是 same 块', () => {
    const blocks = diffTexts('第一行\n第二行', '第一行\n第二行');
    expect(blocks.every((b) => b.kind === 'same')).toBe(true);
    expect(blocks).toHaveLength(2);
  });

  it('修改行生成内嵌字符 diff 的 change 块', () => {
    const blocks = diffTexts('第一行\n旧的第二行\n第三行', '第一行\n新的第二行\n第三行');
    const change = blocks.filter((b) => b.kind === 'change');
    expect(change).toHaveLength(1);
    const segs = change[0].segments;
    expect(segs).toContainEqual({ type: 'del', text: '旧' });
    expect(segs).toContainEqual({ type: 'ins', text: '新' });
    // 未变行保持 same
    expect(blocks.filter((b) => b.kind === 'same').map((b) => b.segments[0].text)).toEqual([
      '第一行',
      '第三行',
    ]);
  });

  it('纯新增行进入 change 块', () => {
    const blocks = diffTexts('第一行', '第一行\n第二行');
    const change = blocks.filter((b) => b.kind === 'change');
    expect(change).toHaveLength(1);
    expect(change[0].segments).toEqual([{ type: 'ins', text: '第二行' }]);
  });
});
