import { describe, expect, it } from 'vitest';
import { stripMarkupWrapper } from '../src/llm/outputClean';

describe('stripMarkupWrapper', () => {
	it('剥离 article 包裹（模型复述定界标签的实例）', () => {
		const body = "The sons' lack of a sense of the value of money.";
		expect(stripMarkupWrapper(`<article>\n${body}\n</article>`)).toBe(body);
	});

	it('剥离 Markdown 代码栅栏', () => {
		expect(stripMarkupWrapper('```\n改写后的正文\n```')).toBe('改写后的正文');
		expect(stripMarkupWrapper('```markdown\n改写后的正文\n```')).toBe('改写后的正文');
	});

	it('多层包裹（栅栏套标签）逐层剥净', () => {
		expect(stripMarkupWrapper('```\n<section>\n<div>\n正文\n</div>\n</section>\n```')).toBe('正文');
	});

	it('无包裹原样返回（仅去首尾空白）', () => {
		expect(stripMarkupWrapper('  一段普通的改写结果。\n')).toBe('一段普通的改写结果。');
	});

	it('正文级标签不剥（避免误伤内容）', () => {
		const text = '<p>这本身就是要保留的段落标记</p>';
		expect(stripMarkupWrapper(text)).toBe(text);
	});

	it('只剥首尾成对包裹，正文中间的标签保留', () => {
		const out = '<article>\n前文\n<div>中间保留</div>\n后文\n</article>';
		expect(stripMarkupWrapper(out)).toBe('前文\n<div>中间保留</div>\n后文');
	});
});
