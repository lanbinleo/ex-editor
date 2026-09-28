import { describe, expect, it } from 'vitest';

// M0 管线冒烟测试：只验证 vitest 接线正确。
// M1 起由移植自 legacy 的纯模块单测（validate/protected/apply/diff）取代。
describe('M0 冒烟测试', () => {
	it('vitest 管线可用', () => {
		expect(1 + 1).toBe(2);
	});
});
