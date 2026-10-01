/**
 * 模型改写输出的防御性净化：剥离外围包裹，只留正文。
 * 模型偶尔会把用户提示词里的定界标签（如 <article>…</article>）或代码栅栏
 * 复述进输出——一旦带上，改写预览的行对齐 diff 整体失效（全删全增）。
 * 提示词已明确禁止，这里是第二层保险。
 */

/** 允许剥离的结构性包裹标签（首尾成对才剥；不含 p 等正文级标签，避免误伤内容） */
const WRAP_TAGS = new Set(['article', 'section', 'div', 'main', 'document', 'html', 'body']);

function stripOnce(text: string): string {
	// Markdown 代码栅栏：```lang\n…\n```
	const fence = /^```[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(text);
	if (fence?.[1] !== undefined) return fence[1].trim();
	// 成对结构性标签：<article>\n…\n</article>（标签名在白名单内）
	const tag = /^<([a-zA-Z][a-zA-Z0-9]*)>[ \t]*\n?([\s\S]*?)\n?[ \t]*<\/\1>\s*$/.exec(text);
	const name = tag?.[1]?.toLowerCase();
	if (tag?.[2] !== undefined && name !== undefined && WRAP_TAGS.has(name)) {
		return tag[2].trim();
	}
	return text;
}

/** 剥离首尾空白与多层外围包裹（栅栏 + 标签交替出现也能剥干净）；无包裹则原样返回 */
export function stripMarkupWrapper(text: string): string {
	let out = text.trim();
	for (let guard = 0; guard < 4; guard++) {
		const next = stripOnce(out);
		if (next === out) break;
		out = next;
	}
	return out;
}
