/**
 * 受保护语法范围：这些区间内的文字不参与校对定位（模型也不应修改它们）。
 * 保护清单：frontmatter、围栏代码、数学、wiki 链接、嵌入、图片、行内代码、行内数学、callout 标记。
 */
export interface ProtectedRange {
	start: number;
	end: number;
}

/** frontmatter 只在文档开头匹配 */
const frontmatterPattern = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

const globalPatterns: RegExp[] = [
	/```[\s\S]*?```/g,
	/~~~[\s\S]*?~~~/g,
	/\$\$[\s\S]*?\$\$/g,
	/!?\[\[[^\]\n]+\]\]/g,
	/!\[[^\]\n]*\]\([^)\n]+\)/g,
	/`[^`\n]+`/g,
	/\$[^$\n]+\$/g,
	/\[![-_a-zA-Z0-9]+\]/g,
];

export function findProtectedRanges(text: string): ProtectedRange[] {
	const ranges: ProtectedRange[] = [];
	const fm = frontmatterPattern.exec(text);
	if (fm) ranges.push({ start: fm.index, end: fm.index + fm[0].length });
	for (const re of globalPatterns) {
		re.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = re.exec(text)) !== null) {
			ranges.push({ start: m.index, end: m.index + m[0].length });
		}
	}
	ranges.sort((a, b) => a.start - b.start);
	return ranges;
}

/** [from, to) 是否与任一保护范围相交。ranges 需已按 start 排序（findProtectedRanges 的返回值）。 */
export function isProtected(ranges: ProtectedRange[], from: number, to: number): boolean {
	for (const r of ranges) {
		if (r.start >= to) break;
		if (r.end > from && r.start < to) return true;
	}
	return false;
}
