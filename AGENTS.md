# AGENTS.md — ExEditor 项目事实与约束

## Project Snapshot

- ExEditor（有经验的编辑）：Obsidian 第三方插件，面向中文写作者的 AI 校对与改稿工具。
- 当前阶段：M1 最小安全闭环（v0.2.0，已验收合并 main，tag `v0.2.0`）；「检查本段落」→ 侧边栏 → 接受/忽略闭环可用，见 `docs/roadmap.md`。
- 技术栈：TypeScript（strict）+ esbuild（打包到 `main.js`）+ vitest + eslint（eslint-plugin-obsidianmd）。运行时依赖 Obsidian 内置的 CodeMirror 6（`@codemirror/*` 仅作 devDependencies 提供类型，esbuild 中 external）。
- 开发位置特殊：本仓库就在 vault 内（`写作人生/.obsidian/plugins/exeditor/`），**构建产物 main.js 即运行时插件**，原地开发，无部署步骤。
- 本仓库是独立 Git 仓库，vault 的 `.gitignore` 已排除本目录；旧插件 `editing-suggestions` 仍安装在同一 vault（id 不同，共存，M4 后由用户手动停用）。

## Product Rules（安全红线，任何改动不得违反）

1. **永不弄丢用户文字**：对文稿的一切批量修改必须合并为单个编辑器事务（可一次 Ctrl+Z 撤销），批量应用前先创建快照。
2. **定位永不猜测**：AI 建议只在"原文在文中唯一出现"时生效；定位失败即标记 stale 丢弃，宁可漏改不可错改。
3. **保护区域绝不改写**：frontmatter、代码块、数学公式（`$`/`$$`）、wikilink、图片、行内代码、callout 标记。
4. **密钥只存本地**：API Key 保存在 `data.json`（已 gitignore），绝不写入代码、文档或提交。
5. **UI 禁止全量重建**：侧边栏等界面组件按条目精确增删改（保留 DOM 节点、焦点与滚动位置），禁止 `root.empty()` 式整体重渲染——这是旧版的核心病灶。
6. 界面文案使用中文；函数名、API、配置名保持英文。

## Technical Decisions

- 安全核心（validate/protected/apply/diff/parse）从 `legacy/writingbuddy/` 移植并保持纯函数、可单测；业务编排拆分为独立控制器（check/suggestion/backup），`Plugin` 类只管生命周期与注册。
- LLM 传输：fetch + AbortController 优先（可取消），obsidian requestUrl 仅作兜底；OpenAI 兼容协议 + 提供商预设。
- 编辑器标记：CM6 StateField + RangeSet（M2），标记随事务自动映射，跨行标记按行拆分。
- 包管理器 npm；模块格式 CJS（esbuild，target ES2021）；不引入运行时第三方依赖。

## Important Files

| 文件 | 职责 |
|---|---|
| `manifest.json` | 插件身份（id `exeditor`）。修改 id/name 需重启 Obsidian 才生效 |
| `src/main.ts` | 唯一入口，`ExEditorPlugin`。只管生命周期与注册，不含业务逻辑；改动结构时同步本表与 README |
| `src/core/` | 安全核心纯函数（parse/protected/validate/diff/apply/paragraph），可单测，不依赖 obsidian API |
| `src/controller/` | 业务编排：`checkController` 段落检查、`suggestionController` 建议管理（M1 为内存态） |
| `src/view/sidebar.ts` + `card.ts` | 侧边栏 v1（精确更新红线在此落实）与建议卡片 DOM |
| `src/llm/` | LLM 客户端（fetch 优先 + requestUrl 兜底）与提示词 |
| `src/settings.ts` | 设置页与提供商预设 |
| `src/editorContext.ts` | 「当前操作的文档」解析（焦点回落到最近编辑的 Markdown 视图） |
| `esbuild.config.mjs` | 打包配置，entry 固定 `src/main.ts`，CM6/lezer/obsidian 均 external |
| `tests/*.spec.ts` | vitest 单测；M1 起为移植的核心模块测试 |
| `legacy/writingbuddy/` | 旧项目只读快照，**不参与构建**，移植时从此复制后在新 src/ 修改 |
| `docs/` | 产品/路线/状态/流程四份文档，职责见 Documentation Rules |

## Working Rules

- 改动 TS 代码后：`npm run build && npm test && npm run lint` 三绿才算完成。
- 从 legacy 移植代码：复制到新 `src/` 后按新架构调整，legacy 文件本身不修改。
- 里程碑完成时同步更新 `docs/implementation-status.md`；行为/能力变化同步 `README.md` 与 `docs/product-design.md`。
- 提交前 `git status` 检查：不得出现 `data.json`、`node_modules/`、`*.map`。
- 版本号通过 `npm version` 命令变更（自动同步 manifest.json 与 versions.json），不手改。

## Data and Security

- `data.json`：插件运行时配置（含 API Key），已 gitignore，永不入库。
- 备份快照（M4 起）：写入 vault 内约定目录，属于用户稿子数据；删除/清理必须遵循保留数量上限，恢复前先快照当前版。
- 用户文稿是最高优先级数据：任何功能设计的默认答案是不改动它，除非用户明确触发。

## Verification

- 自动：`npm run build`（tsc 类型检查 + esbuild 生产构建）、`npm test`（vitest）、`npm run lint`。
- 真机（必须在真实 vault 的 Obsidian 中人工确认）：插件加载无控制台报错；命令面板可执行冒烟命令；每次涉及文稿修改的功能：应用后 Ctrl+Z 能完整撤销；长文档（≥3 万字）不卡顿。
- 涉及 AI 请求的功能：配置 DeepSeek/GLM/OpenAI 任一真实 Key 走通全流程。

## Branching and Commits

- `main`：稳定可验证状态，里程碑完成时合并。
- `dev/x.y.z`：一个里程碑的持续开发；`feat/<name>`、`fix/<name>`、`docs/<name>` 短分支。
- Conventional Commits（`feat:`/`fix:`/`docs:`/`chore:`），描述可中文。

## Release Process

- 暂无对外发布渠道（个人使用）。`npm version patch|minor` 触发 `version-bump.mjs` 同步 manifest.json 与 versions.json。
- 未来若上社区市场：需补英文 README、检查 manifest 字段完整性与上架审核要求。

## Documentation Rules

- 产品决策与能力设计 → `docs/product-design.md`（唯一维护点）
- 未来计划与非目标 → `docs/roadmap.md`
- 当前完成状态与验证记录 → `docs/implementation-status.md`
- 开发流程与版本规则 → `docs/development-workflow.md`
- 外部原始资料 → `legacy/writingbuddy/design/`（保持来源，不当成已确认决策）

## Definition of Done

功能在真实 Obsidian 中可用且：build/test/lint 三绿；文稿修改可撤销且应用前有快照（涉及文稿时）；相关文档已同步；无密钥或运行时数据入库；工作区无未说明的遗留改动。

## Open Decisions

| 事项 | 当前处理 | 何时需要决定 |
|---|---|---|
| 是否发布社区插件市场 | 不发布，个人使用 | M5 打磨期 |
| `main.js` 是否入库 | 入库（构建产物即运行时插件，方便任意 commit 直接可用） | 上 GitHub release 流程时 |
| `isDesktopOnly` | false，但移动端不做测试承诺 | 出现移动端需求时 |
| 闲置段落自动检查默认开关 | 默认关闭（roadmap M5） | M5 实现时 |
