import { CATEGORIES, SEVERITIES } from '../types';
import type { Category, RawIssue, Severity, Suggestion, SuggestionSource } from '../types';
import { isProtected } from './protected';
import type { ProtectedRange } from './protected';
import { newId } from '../util';

const MAX_ORIGINAL = 500;
const MAX_REPLACEMENT = 2000;
const MAX_EXPLANATION = 300;

interface CleanedIssue {
	original: string;
	replacement: string;
	category: Category;
	severity: Severity;
	explanation: string;
}

/** 字段清洗与白名单校验；非法（空、超长、原文=替换）返回 null。 */
export function sanitizeIssue(raw: RawIssue): CleanedIssue | null {
	const original = typeof raw.original === 'string' ? raw.original : '';
	const replacement = typeof raw.replacement === 'string' ? raw.replacement : '';
	if (!original || original.length > MAX_ORIGINAL) return null;
	if (!replacement || replacement.length > MAX_REPLACEMENT) return null;
	if (original === replacement) return null;
	const category = CATEGORIES.includes(raw.category as Category)
		? (raw.category as Category)
		: 'wording';
	const severity = SEVERITIES.includes(raw.severity as Severity)
		? (raw.severity as Severity)
		: 'probable';
	const explanation =
		typeof raw.explanation === 'string' ? raw.explanation.slice(0, MAX_EXPLANATION) : '';
	return { original, replacement, category, severity, explanation };
}

/**
 * 在 [searchFrom, searchTo) 内查找 original 的唯一出现位置。
 * 只统计不受保护范围内的出现；0 处或 ≥2 处都返回 null（无法安全定位）。
 */
export function uniqueOccurrence(
	original: string,
	docText: string,
	searchFrom: number,
	searchTo: number,
	protectedRanges: ProtectedRange[],
): number | null {
	const len = original.length;
	if (!len || searchFrom >= searchTo) return null;
	let found: number | null = null;
	let idx = docText.indexOf(original, searchFrom);
	while (idx !== -1) {
		if (idx + len > searchTo) break;
		if (!isProtected(protectedRanges, idx, idx + len)) {
			if (found !== null) return null;
			found = idx;
		}
		idx = docText.indexOf(original, idx + 1);
	}
	return found;
}

export interface LocatedSuggestion {
	suggestion: Suggestion;
	from: number;
	to: number;
}

export interface LocateOutcome {
	accepted: LocatedSuggestion[];
	droppedCount: number;
}

/**
 * 校验模型返回的 issues 并定位到文档：
 * - original 必须在检查范围内唯一出现（否则丢弃，绝不猜位置）
 * - 相互重叠的建议保留先出现的
 */
export function validateAndLocate(
	raws: RawIssue[],
	docText: string,
	scopeFrom: number,
	scopeTo: number,
	protectedRanges: ProtectedRange[],
	source: SuggestionSource = 'full',
): LocateOutcome {
	const accepted: LocatedSuggestion[] = [];
	let dropped = 0;

	raws.forEach((raw) => {
		const cleaned = sanitizeIssue(raw);
		if (!cleaned) {
			dropped++;
			return;
		}
		// 先按原文精确匹配；失败再尝试去首尾空白（模型偶尔带空格）
		let matchedOriginal: string | null = null;
		let at: number | null = null;
		for (const variant of [cleaned.original, cleaned.original.trim()]) {
			if (!variant) continue;
			const pos = uniqueOccurrence(variant, docText, scopeFrom, scopeTo, protectedRanges);
			if (pos !== null) {
				matchedOriginal = variant;
				at = pos;
				break;
			}
		}
		if (at === null || matchedOriginal === null) {
			dropped++;
			return;
		}
		const from = at;
		const to = at + matchedOriginal.length;
		const overlaps = accepted.some((a) => a.from < to && from < a.to);
		if (overlaps) {
			dropped++;
			return;
		}
		accepted.push({
			from,
			to,
			suggestion: {
				id: newId('ex'),
				original: matchedOriginal,
				replacement: cleaned.replacement.trim() || cleaned.replacement,
				category: cleaned.category,
				severity: cleaned.severity,
				explanation: cleaned.explanation,
				status: 'pending',
				source,
				createdAt: Date.now(),
			},
		});
	});

	accepted.sort((a, b) => a.from - b.from);
	return { accepted, droppedCount: dropped };
}

export interface RelocateResult {
	marks: { suggestion: Suggestion; from: number; to: number }[];
	staleIds: string[];
}

/**
 * 把已存的建议重新定位到当前文档（持久化建议恢复时使用）。
 * 定位失败（原文已变或不再唯一）的标记为 stale。
 */
export function relocateSuggestions(
	suggestions: Suggestion[],
	docText: string,
	protectedRanges: ProtectedRange[],
): RelocateResult {
	const marks: RelocateResult['marks'] = [];
	const staleIds: string[] = [];
	for (const sug of suggestions) {
		const at = uniqueOccurrence(sug.original, docText, 0, docText.length, protectedRanges);
		if (at === null) {
			staleIds.push(sug.id);
			continue;
		}
		const from = at;
		const to = at + sug.original.length;
		if (marks.some((m) => m.from < to && from < m.to)) {
			staleIds.push(sug.id);
			continue;
		}
		marks.push({ suggestion: sug, from, to });
	}
	return { marks, staleIds };
}
