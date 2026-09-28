export function truncate(s: string, n: number): string {
	return s.length > n ? s.slice(0, n) + '…' : s;
}

export function newId(prefix = 'ex'): string {
	return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function pad(n: number): string {
	return n < 10 ? '0' + n : String(n);
}

/** 快照文件名用时间戳：20260928-153045 */
export function timestampStamp(): string {
	const d = new Date();
	return (
		`${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
		`-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
	);
}

/** 界面显示时间：同天显示 HH:mm，否则 M月d日 HH:mm */
export function formatClock(ts: number): string {
	if (!ts) return '';
	const d = new Date(ts);
	const now = new Date();
	const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
	if (d.toDateString() === now.toDateString()) return hhmm;
	return `${d.getMonth() + 1}月${d.getDate()}日 ${hhmm}`;
}
