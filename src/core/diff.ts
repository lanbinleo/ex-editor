/**
 * 词级与行对齐 diff，用于建议卡片与重写预览的「正文式标记」：
 * 只标记改动本身（删=红底删除线、增=绿底），未变文字不加样式。
 * 颗粒度是词（中文按分词、英文按单词），避免整词替换被拆成字符碎片。
 */

export interface Seg {
	type: 'equal' | 'del' | 'ins';
	text: string;
}

/**
 * LCS 规模上限（token 数乘积），超过则退化为整体替换
 */
const MAX_CELLS = 4_000_000;

/** Intl.Segmenter 的最小结构类型（ES2021 lib 未收录；运行时 Chromium 87+/Node 16+ 均有） */
interface WordSegmenterLike {
	segment(input: string): Iterable<{ segment: string }>;
}

const segmenter: WordSegmenterLike | null = (() => {
	const ctor = (Intl as unknown as {
		Segmenter?: new (locale: string, options: { granularity: 'word' }) => WordSegmenterLike;
	}).Segmenter;
	if (!ctor) return null;
	try {
		return new ctor('zh', { granularity: 'word' });
	} catch {
		return null;
	}
})();

/**
 * 分词：中文按词典切成词、英文按单词，空白与标点各自成段；token 拼接等于原文。
 * 环境不支持 Intl.Segmenter 时回退按码点切分（颗粒度退化为字）。
 */
function tokenize(text: string): string[] {
	if (!segmenter) return Array.from(text);
	const tokens: string[] = [];
	for (const s of segmenter.segment(text)) tokens.push(s.segment);
	return tokens;
}

/**
 * 词级 diff（中文按分词、英文按单词比较整词；回退环境下按字）。
 * 返回按顺序拼接后等于 a（只看 equal+del）与 b（只看 equal+ins）的片段序列。
 */
export function wordDiff(a: string, b: string): Seg[] {
	if (a === b) return [{ type: 'equal', text: a }];
	if (!a) return [{ type: 'ins', text: b }];
	if (!b) return [{ type: 'del', text: a }];
	const xs = tokenize(a);
	const ys = tokenize(b);
	if (xs.length * ys.length > MAX_CELLS) {
		return [{ type: 'del', text: a }, { type: 'ins', text: b }];
	}
	const n = xs.length;
	const m = ys.length;
	const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
	for (let i = n - 1; i >= 0; i--) {
		const row = dp[i] ?? new Uint32Array(m + 1);
		const next = dp[i + 1] ?? new Uint32Array(m + 1);
		for (let j = m - 1; j >= 0; j--) {
			row[j] = xs[i] === ys[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
		}
	}
	const segs: Seg[] = [];
	const push = (type: Seg['type'], text: string): void => {
		if (!text) return;
		const last = segs[segs.length - 1];
		if (last && last.type === type) last.text += text;
		else segs.push({ type, text });
	};
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		const x = xs[i];
		const y = ys[j];
		if (x !== undefined && y !== undefined && x === y) {
			push('equal', x);
			i++;
			j++;
		} else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
			if (x !== undefined) push('del', x);
			i++;
		} else {
			if (y !== undefined) push('ins', y);
			j++;
		}
	}
	while (i < n) {
		const x = xs[i];
		if (x !== undefined) push('del', x);
		i++;
	}
	while (j < m) {
		const y = ys[j];
		if (y !== undefined) push('ins', y);
		j++;
	}
	return segs;
}

export interface DiffBlock {
	/** same：未变化的行；change：内嵌字符级增删的行组 */
	kind: 'same' | 'change';
	segments: Seg[];
}

/**
 * 行对齐 + 行内词级 diff：
 * 先按行做 LCS 对齐，再把连续的「删行/增行」配对，对每对做词级 diff，
 * 得到接近「改了哪几个词」的正文式对照。
 */
export function diffTexts(aText: string, bText: string): DiffBlock[] {
	const a = aText.length ? aText.split('\n') : [];
	const b = bText.length ? bText.split('\n') : [];
	if (a.length * b.length > 4_000_000) {
		return [
			{ kind: 'change', segments: [...wordDiff(aText, '')] },
			{ kind: 'change', segments: [...wordDiff('', bText)] },
		];
	}
	const n = a.length;
	const m = b.length;
	const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--) {
		const row = dp[i] ?? [];
		const next = dp[i + 1] ?? [];
		for (let j = m - 1; j >= 0; j--) {
			row[j] = a[i] === b[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
		}
	}
	const blocks: DiffBlock[] = [];
	let delRun: string[] = [];
	let addRun: string[] = [];
	const flushChange = (): void => {
		if (!delRun.length && !addRun.length) return;
		const pairs = Math.min(delRun.length, addRun.length);
		const segments: Seg[] = [];
		for (let k = 0; k < pairs; k++) {
			if (k > 0) segments.push({ type: 'equal', text: '\n' });
			segments.push(...wordDiff(delRun[k] ?? '', addRun[k] ?? ''));
		}
		for (let k = pairs; k < delRun.length; k++) {
			if (segments.length) segments.push({ type: 'equal', text: '\n' });
			segments.push({ type: 'del', text: delRun[k] ?? '' });
		}
		for (let k = pairs; k < addRun.length; k++) {
			if (segments.length) segments.push({ type: 'equal', text: '\n' });
			segments.push({ type: 'ins', text: addRun[k] ?? '' });
		}
		blocks.push({ kind: 'change', segments });
		delRun = [];
		addRun = [];
	};
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			flushChange();
			blocks.push({ kind: 'same', segments: [{ type: 'equal', text: a[i] ?? '' }] });
			i++;
			j++;
		} else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
			delRun.push(a[i] ?? '');
			i++;
		} else {
			addRun.push(b[j] ?? '');
			j++;
		}
	}
	while (i < n) {
		delRun.push(a[i] ?? '');
		i++;
	}
	while (j < m) {
		addRun.push(b[j] ?? '');
		j++;
	}
	flushChange();
	return blocks;
}
