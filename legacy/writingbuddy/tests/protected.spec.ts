import { describe, expect, it } from 'vitest';
import { findProtectedRanges, isProtected } from '../src/core/protected';

describe('findProtectedRanges', () => {
  it('识别文档开头的 frontmatter', () => {
    const text = '---\ntitle: 一个标题\n---\n正文开始';
    const ranges = findProtectedRanges(text);
    expect(ranges.some((r) => text.slice(r.start, r.end).startsWith('---\ntitle'))).toBe(true);
  });

  it('正文中段的 --- 不被当作 frontmatter', () => {
    const text = '第一行\n---\n第二行';
    const ranges = findProtectedRanges(text);
    expect(ranges).toHaveLength(0);
  });

  it('识别围栏代码块', () => {
    const text = '前文\n```js\nconst a = 1;\n```\n后文';
    const ranges = findProtectedRanges(text);
    expect(ranges.some((r) => text.slice(r.start, r.end).includes('const a'))).toBe(true);
  });

  it('识别 wikilink 与嵌入', () => {
    const text = '见 [[某篇笔记]] 与 ![[图片.png]]';
    const ranges = findProtectedRanges(text);
    expect(ranges.some((r) => text.slice(r.start, r.end) === '[[某篇笔记]]')).toBe(true);
    expect(ranges.some((r) => text.slice(r.start, r.end) === '![[图片.png]]')).toBe(true);
  });

  it('识别行内代码与行内数学', () => {
    const text = '代码 `x=1` 与公式 $a+b$';
    const ranges = findProtectedRanges(text);
    expect(ranges.some((r) => text.slice(r.start, r.end) === '`x=1`')).toBe(true);
    expect(ranges.some((r) => text.slice(r.start, r.end) === '$a+b$')).toBe(true);
  });
});

describe('isProtected', () => {
  it('相交判断', () => {
    const ranges = [{ start: 10, end: 20 }];
    expect(isProtected(ranges, 12, 15)).toBe(true);
    expect(isProtected(ranges, 5, 10)).toBe(false);
    expect(isProtected(ranges, 20, 25)).toBe(false);
    expect(isProtected(ranges, 0, 30)).toBe(true);
  });
});
