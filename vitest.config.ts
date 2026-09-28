import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		// 默认排除项 + legacy 目录（旧项目快照只作参考，不参与测试）
		exclude: ['**/node_modules/**', '**/dist/**', 'legacy/**'],
	},
});
