/**
 * SSE（Server-Sent Events）增量解析器，纯函数、可单测。
 * OpenAI 兼容流式响应：每个事件是 `data: {JSON}`，流以 `data: [DONE]` 终止。
 * 规则（MDN）：事件以空行分隔；同一事件的多行 data 拼接（中间插 \n）；
 * 冒号开头的行是注释（keep-alive），忽略；CRLF 与 LF 都要容忍。
 */

export interface SseParser {
	/** 喂入一段增量文本（可任意切分），完整事件的 data 逐个回调 */
	push(chunk: string): void;
	/** 流结束；缓冲中若有未以空行收尾的事件，也交出去 */
	end(): void;
}

export function createSseParser(onData: (data: string) => void): SseParser {
	let buffer = '';
	let pendingDataLines: string[] = [];

	const flushEvent = (): void => {
		if (!pendingDataLines.length) return;
		const data = pendingDataLines.join('\n');
		pendingDataLines = [];
		if (data.length) onData(data);
	};

	const processLine = (line: string): void => {
		if (line === '') {
			flushEvent();
			return;
		}
		if (line.startsWith(':')) return; // 注释/keep-alive
		if (line.startsWith('data:')) {
			let value = line.slice(5);
			if (value.startsWith(' ')) value = value.slice(1);
			pendingDataLines.push(value);
		}
		// 其他字段（event:/id:/retry:）忽略
	};

	return {
		push(chunk: string): void {
			buffer += chunk;
			let nl: number;
			while ((nl = findLineBreak(buffer)) !== -1) {
				const line = buffer.slice(0, nl);
				buffer = buffer.slice(nl + lineBreakLength(buffer, nl));
				processLine(line);
			}
		},
		end(): void {
			if (buffer) {
				processLine(buffer);
				buffer = '';
			}
			flushEvent();
		},
	};
}

function findLineBreak(s: string): number {
	const lf = s.indexOf('\n');
	const cr = s.indexOf('\r');
	if (lf === -1 && cr === -1) return -1;
	if (cr === -1 || (lf !== -1 && lf < cr)) return lf;
	return cr;
}

function lineBreakLength(s: string, at: number): number {
	// \r\n 记 2，单独 \r 或 \n 记 1
	if (s[at] === '\r' && s[at + 1] === '\n') return 2;
	return 1;
}
