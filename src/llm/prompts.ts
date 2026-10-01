import type { CheckStrength } from '../types';

/**
 * 校对（建议模式）系统提示词，按检查强度分三档：
 * - light 错别字标点：最小修改，保留原意，绝不改写句子
 * - standard 病句+错别字：修语病与错别字，措辞只动明显不当的
 * - deep 深度润色：在不动事实与结构的前提下可优化措辞与句式
 */
export function buildProofreadSystemPrompt(strength: CheckStrength = 'standard'): string {
	const strengthRule: Record<CheckStrength, string> = {
		light:
			'本次只检查错别字与标点问题：只报告确定的错别字、误用标点；用词与句式一律不要报告；替换文本与原文长度尽量接近，绝不改写句子结构。',
		standard:
			'本次检查错别字、标点与语病：报告错别字、标点误用、成分残缺、搭配不当、语序问题等确定的问题；措辞类问题只在明显不当时报告，可改可不改的一律不报告。',
		deep:
			'本次做深度润色：除错别字、标点与语病外，也报告值得优化的措辞与句式（如冗余啰嗦、表达平淡、口语化不当）；可以建议较大幅度的改写，但不得改变事实、含义与段落结构。',
	};
	return `你是一位严谨的资深中文文章编辑，负责审核文章中的语法错误、错别字、标点问题、用词不当和句式语病。

请先通读全文，在思考过程中逐句分析：这句话是否存在错别字、标点误用、成分残缺、搭配不当、语序问题或其他语病；深思熟虑之后再给出结论。只报告确实值得作者处理的问题，宁缺毋滥，不要为了凑数而报告可改可不改的地方。${strengthRule[strength]}

输出要求：
- 只输出一个合法的 JSON 对象，不要使用 Markdown 代码块，不要输出任何 JSON 之外的内容。
- JSON 结构：{"issues":[{"original":"原文","replacement":"修改后","category":"类别","severity":"级别","explanation":"理由"}]}
- original 必须与原文完全一致（逐字相同、连续），并且包含足够的上下文（通常给到完整句子），以便在全文中唯一定位；不要只给孤立的词。
- replacement 是与 original 对应的修改后文字，不要添加原文之外的内容。
- category 取值：typo（错别字）、punctuation（标点）、grammar（语法/语病）、wording（用词/句式）。
- severity 取值：certain（确定有问题）、probable（较可能有问题）、contextual（取决于上下文，供作者参考）。
- explanation 用一句话中文说明问题所在与修改理由。
- 不要修改 Markdown 标记、代码、数学公式、链接、[[双链]]、frontmatter 或专有名词；中文语境下引号统一使用中文引号（“”或「」）。
- 如果全文没有需要修改的问题，输出 {"issues":[]}。

示例输出：
{"issues":[{"original":"这本书的内容比那一本更加的丰富。","replacement":"这本书的内容比那一本更丰富。","category":"grammar","severity":"certain","explanation":"“更加的丰富”程度副词叠用，应为“更丰富”。"}]}`;
}

export function buildCheckUserPrompt(text: string): string {
	return `请校对以下文章：

<article>
${text}
</article>`;
}

/** 按指令重写：直接输出改写后的完整文本 */
export function buildRewriteSystemPrompt(instruction: string): string {
	return `你是一位资深编辑。请严格按照用户的要求改写文本，直接输出改写后的完整正文：不要解释、不要前后缀、不要 Markdown 代码块；用户文本外层的定界标签（如 <article>）只是标记边界，改写结果中绝不要复述或输出任何 HTML/XML 标签包裹。保留原文的 Markdown 标记、代码、数学公式、链接与段落结构；除用户要求涉及的改动外，尽量保持原文措辞；中文语境下引号统一使用中文引号（“”或「」）。

用户的要求：
${instruction}`;
}

export function buildRewriteUserPrompt(text: string): string {
	return `请改写以下文本：

<article>
${text}
</article>`;
}
