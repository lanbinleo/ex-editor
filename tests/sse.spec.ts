import { describe, expect, it } from 'vitest';
import { createSseParser } from '../src/llm/sse';

function collect(): { data: string[]; parser: ReturnType<typeof createSseParser> } {
	const data: string[] = [];
	return { data, parser: createSseParser((d) => data.push(d)) };
}

describe('createSseParser', () => {
	it('解析基本的 data 事件', () => {
		const { data, parser } = collect();
		parser.push('data: {"a":1}\n\n');
		parser.end();
		expect(data).toEqual(['{"a":1}']);
	});

	it('任意切分的增量也能正确分帧', () => {
		const { data, parser } = collect();
		parser.push('data: {"choices"');
		parser.push(':[{"delta":{"content":"你"}}]}\n');
		parser.push('\ndata: [DONE]\n\n');
		parser.end();
		expect(data).toEqual(['{"choices":[{"delta":{"content":"你"}}]}', '[DONE]']);
	});

	it('同一事件的多行 data 用换行拼接', () => {
		const { data, parser } = collect();
		parser.push('data: 第一行\ndata: 第二行\n\n');
		parser.end();
		expect(data).toEqual(['第一行\n第二行']);
	});

	it('忽略冒号开头的注释行（keep-alive）', () => {
		const { data, parser } = collect();
		parser.push(': ping\n\ndata: {"ok":1}\n\n');
		parser.end();
		expect(data).toEqual(['{"ok":1}']);
	});

	it('容忍 CRLF 换行', () => {
		const { data, parser } = collect();
		parser.push('data: {"a":1}\r\n\r\ndata: [DONE]\r\n\r\n');
		parser.end();
		expect(data).toEqual(['{"a":1}', '[DONE]']);
	});

	it('end() 时交出未以空行收尾的尾部事件', () => {
		const { data, parser } = collect();
		parser.push('data: {"tail":1}\n');
		parser.end();
		expect(data).toEqual(['{"tail":1}']);
	});

	it('data 后无空格也能解析', () => {
		const { data, parser } = collect();
		parser.push('data:{"a":1}\n\n');
		parser.end();
		expect(data).toEqual(['{"a":1}']);
	});

	it('忽略 event/id 等其他字段行', () => {
		const { data, parser } = collect();
		parser.push('event: message\nid: 7\ndata: {"a":1}\n\n');
		parser.end();
		expect(data).toEqual(['{"a":1}']);
	});
});
