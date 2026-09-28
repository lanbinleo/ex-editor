import { describe, expect, it } from 'vitest';
import { DEFAULT_PRICING, estimateCostYuan, formatYuan, getPricing } from '../src/llm/pricing';
import type { ExSettings } from '../src/types';

// 纯字面量构造，避免引入 settings.ts（其依赖 obsidian 模块，vitest 环境不可用）
const base: ExSettings = {
	preset: 'deepseek',
	baseURL: 'https://example.com/v1',
	apiKey: 'sk-test',
	model: 'deepseek-flash',
	reasoningMode: 'auto',
	reasoningEffort: 'medium',
	pricing: {},
};

describe('pricing', () => {
	it('内置价格包含常用模型，数值为正', () => {
		expect(DEFAULT_PRICING['deepseek-flash']).toEqual({ input: 2, output: 8 });
		expect(DEFAULT_PRICING['glm-4.7']?.input ?? 0).toBeGreaterThan(0);
	});

	it('getPricing：用户自定义优先于内置', () => {
		const settings: ExSettings = {
			...base,
			pricing: { 'deepseek-flash': { input: 99, output: 99 } },
		};
		expect(getPricing(settings, 'deepseek-flash')).toEqual({ input: 99, output: 99 });
	});

	it('getPricing：无价格返回 null（如 glm-4.6 已下架定价）', () => {
		expect(getPricing(base, 'glm-4.6')).toBeNull();
		expect(getPricing(base, 'unknown-model')).toBeNull();
	});

	it('费用估算：百万 tokens 量级正确', () => {
		expect(estimateCostYuan({ input: 2, output: 8 }, 1_000_000, 0)).toBeCloseTo(2);
		expect(estimateCostYuan({ input: 2, output: 8 }, 0, 1_000_000)).toBeCloseTo(8);
		// 典型段落检查：3k 输入 + 1k 输出 ≈ ¥0.014
		expect(estimateCostYuan({ input: 2, output: 8 }, 3000, 1000)).toBeCloseTo(0.014, 4);
	});

	it('formatYuan 按量级保留小数位', () => {
		expect(formatYuan(0)).toBe('¥0');
		expect(formatYuan(0.004)).toBe('¥0.0040');
		expect(formatYuan(0.014)).toBe('¥0.014');
		expect(formatYuan(0.5)).toBe('¥0.500');
		expect(formatYuan(12.345)).toBe('¥12.35');
	});
});
