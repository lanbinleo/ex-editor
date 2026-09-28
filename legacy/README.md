# legacy/ — 旧项目存档（只读参考）

本目录是旧项目「编辑建议（editing-suggestions）」的完整源码快照，来源：`D:\Desktop\WritingBuddy` @ commit `904d67e`（2026-09）。旧仓库本身保持原样不动。

**本目录不参与构建**：根 `tsconfig.json`、`eslint.config.mts` 均已排除此目录，esbuild 入口只认 `src/main.ts`。可以阅读、可以复制代码到新 `src/` 后修改，但不要直接在这里改动并期望生效。

## 移植优先级（M1 起）

| 优先级 | 文件 | 处置 |
|---|---|---|
| 直接移植 | `src/core/validate.ts`、`protected.ts`、`apply.ts`、`diff.ts`、`parse.ts` | 连同 `tests/` 下 5 个 spec 原样移植，是本项目安全协议的核心 |
| 移植后重写 | `src/llm/client.ts`、`prompts.ts` | JSON 协议与中文错误提示保留；传输层改为 fetch + AbortController 优先，requestUrl 仅兜底 |
| 仅作行为参考 | `src/view/sidebar.ts`、`card.ts`、`src/settings.ts` | 架构废弃（全量重渲染是旧版病灶）；参考其交互行为与文案 |
| 仅作行为参考 | `main.ts`、`src/core/checkService.ts`、`src/storage/*`、`src/editor/*` | 编排逻辑拆成控制器重写；CM6 StateField 思路（findingsField）在 M2 沿用 |

## 设计文档

- `design/plan-v1.md`：旧项目原始设计计划（背景、模块规划、M1-M4 里程碑记录），含"闲置段落自动检查"等未实现设想，已吸收进新 roadmap。
