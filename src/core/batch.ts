/** 全文检查的一批范围 */
export interface Batch {
	from: number;
	to: number;
}

export interface LineInfo {
	from: number;
	to: number;
	text: string;
}

/**
 * 把文档按「空行分隔段落块」聚合成批，目标每批不超过 maxChars 字。
 * 超长段落块不切割（保持提示词语境完整），单独成批。
 * 纯函数：行描述由调用方从 EditorState 提供。
 */
export function splitIntoBatches(lines: LineInfo[], maxChars: number): Batch[] {
	const blocks: Batch[] = [];
	let block: Batch | null = null;
	for (const line of lines) {
		if (line.text.trim() === '') {
			block = null;
			continue;
		}
		if (block) {
			block.to = line.to;
		} else {
			block = { from: line.from, to: line.to };
			blocks.push(block);
		}
	}

	const batches: Batch[] = [];
	let current: Batch | null = null;
	let currentChars = 0;
	for (const b of blocks) {
		const size = b.to - b.from;
		if (current && currentChars > 0 && currentChars + size > maxChars) {
			batches.push(current);
			current = null;
			currentChars = 0;
		}
		if (current) {
			current.to = b.to;
		} else {
			current = { from: b.from, to: b.to };
		}
		currentChars += size;
	}
	if (current) batches.push(current);
	return batches;
}
