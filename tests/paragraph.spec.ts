import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { paragraphRange } from '../src/core/paragraph';

const DOC = '第一段第一行\n第一段第二行\n\n第二段第一行\n\n\n第三段';

describe('paragraphRange', () => {
	it('光标在段落中间时覆盖整个空行分隔块', () => {
		const state = EditorState.create({ doc: DOC, selection: { anchor: DOC.indexOf('第二行') } });
		const { from, to } = paragraphRange(state);
		expect(DOC.slice(from, to)).toBe('第一段第一行\n第一段第二行');
	});

	it('光标在第二段时只取第二段', () => {
		const state = EditorState.create({ doc: DOC, selection: { anchor: DOC.indexOf('第二段') } });
		const { from, to } = paragraphRange(state);
		expect(DOC.slice(from, to)).toBe('第二段第一行');
	});

	it('连续多个空行只分隔不吞并', () => {
		const state = EditorState.create({ doc: DOC, selection: { anchor: DOC.indexOf('第三段') } });
		const { from, to } = paragraphRange(state);
		expect(DOC.slice(from, to)).toBe('第三段');
	});

	it('单个段落覆盖到文档末尾', () => {
		const state = EditorState.create({ doc: '只有一段', selection: { anchor: 0 } });
		expect(paragraphRange(state)).toEqual({ from: 0, to: 4 });
	});
});
