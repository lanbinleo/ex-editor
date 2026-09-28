import type { LocatedSuggestion } from './validate';
import type { SuggestionEntry } from '../types';

/**
 * 追加新建议（检查结果的「追加」语义）：
 * - 按 original 去重：已存在的原文不再重复入列（模型重复报告同一问题时不叠卡片）
 * - 旧建议永不删除；原文已被编辑改掉的，由重定位校验标 stale 灰显
 * - 结果按定位位置排序，仅影响展示顺序
 */
export function appendLocated(
	existing: SuggestionEntry[],
	incoming: LocatedSuggestion[],
): SuggestionEntry[] {
	const known = new Set(existing.map((e) => e.suggestion.original));
	const added: SuggestionEntry[] = [];
	for (const l of incoming) {
		if (known.has(l.suggestion.original)) continue;
		known.add(l.suggestion.original);
		added.push({ suggestion: l.suggestion, from: l.from, to: l.to });
	}
	// 没有新增就不动现有顺序（避免卡片无谓跳动）
	if (!added.length) return existing;
	return [...existing, ...added].sort((a, b) => a.from - b.from);
}
