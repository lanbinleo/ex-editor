# 实现状态 — ExEditor

> 每个里程碑完成时更新本文件：已完成能力、验证记录、当前限制、下一步入口。

## 当前：M0 骨架（0.1.0，2026-09-28）

### 已完成

- [x] 从官方 obsidian-sample-plugin 重建为 ExEditor（id `exeditor`），独立 git 仓库（main 分支，未提交——等待首次人工检查）
- [x] manifest / versions / package / esbuild / eslint / tsconfig 全部换名与收敛
- [x] vitest 接入，冒烟测试通过
- [x] 旧项目完整快照存档至 `legacy/writingbuddy/`（不参与构建）
- [x] 文档体系：AGENTS.md、README.md、docs/ 四件套
- [x] vault `.gitignore` 排除本目录

### 验证记录（2026-09-28）

| 验证项 | 结果 |
|---|---|
| `npm install` | ✅ 通过 |
| `npm run build`（tsc + esbuild production） | ✅ 通过 |
| `npm test`（vitest） | ✅ 1 个冒烟测试通过 |
| `npm run lint` | ✅ 通过 |
| Obsidian 真机加载 | ⏳ 待用户在 vault 中启用 ExEditor 确认 |

### 当前限制

- 只有一个冒烟命令，无任何实际功能（按设计，功能自 M1 起）
- 旧插件 editing-suggestions 仍启用中，与 ExEditor 共存；到 M4 对齐后再停用

### 下一步（M1 入口）

1. 从 `legacy/writingbuddy/src/core/` 复制 validate/protected/apply/diff/parse 到新 `src/core/`，连同 5 个 spec 到 `tests/`，跑绿
2. 新建 `src/settings.ts`（ExEditorSettings + 设置页：provider/baseURL/apiKey/model/测试连接）
3. 「检查本段落」命令 + LLM 客户端 v1（fetch 优先）+ 侧边栏 v1（精确更新列表）
