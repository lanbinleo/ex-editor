# AGENTS.md — ExEditor 项目事实与约束

## Project Snapshot

- ExEditor（有经验的编辑）：Obsidian 第三方插件，面向中文写作者的 AI 校对与改稿工具。
- 当前阶段：M3 已完成发布（0.4.0 验收通过；0.4.1 审核反馈修整 + CI 发布；0.4.2 回退样式改动）；下一步 M4 编辑器内波浪线标记，见 `docs/roadmap.md`。
- 技术栈：TypeScript（strict）+ esbuild（打包到 `main.js`）+ vitest + eslint（eslint-plugin-obsidianmd）。运行时依赖 Obsidian 内置的 CodeMirror 6（`@codemirror/*` 仅作 devDependencies 提供类型，esbuild 中 external）。
- 开发位置特殊：本仓库就在 vault 内（`写作人生/.obsidian/plugins/exeditor/`），**构建产物 main.js 即运行时插件**，原地开发，无部署步骤。
- 本仓库是独立 Git 仓库，vault 的 `.gitignore` 已排除本目录；旧插件 `editing-suggestions` 仍安装在同一 vault（id 不同，共存，M4 后由用户手动停用）。

## Product Rules（安全红线，任何改动不得违反）

1. **永不弄丢用户文字**：对文稿的一切批量修改必须合并为单个编辑器事务（可一次 Ctrl+Z 撤销），批量应用前先创建快照。
2. **定位永不猜测**：AI 建议只在"原文在文中唯一出现"时生效；定位失败即标记 stale 丢弃，宁可漏改不可错改。
3. **保护区域绝不改写**：frontmatter、代码块、数学公式（`$`/`$$`）、wikilink、图片、行内代码、callout 标记。
4. **密钥只存本地**：API Key 按提供商各自保存于 `data.json`（已 gitignore；桌面端 safeStorage 加密落盘为 `enc:` 密文，移动端明文兜底），绝不写入代码、文档或提交。
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
| `src/core/` | 安全核心纯函数（parse/protected/validate/diff/apply/paragraph/batch），可单测，不依赖 obsidian API |
| `src/controller/` | 业务编排：`checkController` 三种范围检查（分批/取消/进度）、`suggestionController` 建议管理（内存态） |
| `src/view/sidebar.ts` + `card.ts` | 侧边栏（精确更新红线在此落实）与建议卡片 DOM |
| `src/llm/` | LLM 客户端（流式 SSE + 非流式兜底 + 思维链参数 + GET /models）与提示词；`sse.ts` 为纯解析器 |
| `src/providers.ts` | 提供商预设/设置迁移/落盘加密转换（纯函数，不依赖 obsidian，可单测） |
| `src/storage/` | `backup.ts` 快照备份；`secureStore.ts` 密钥 safeStorage 加密（桌面）与明文兜底 |
| `src/settings.ts` | 设置页（提供商管理/增删/切换、模型列表、思考深度、备份） |
| `src/editorContext.ts` | 「当前操作的文档」解析（焦点回落到最近编辑的 Markdown 视图） |
| `esbuild.config.mjs` | 打包配置，entry 固定 `src/main.ts`，CM6/lezer/obsidian 均 external |
| `tests/*.spec.ts` | vitest 单测；M1 起为移植的核心模块测试 |
| （legacy/writingbuddy/） | 旧项目存档，**0.4.1 起已从仓库删除**；需要参考时从 git 历史（tag 0.4.0 及更早）取阅，勿再引入仓库 |
| `docs/` | 产品/路线/状态/流程四份文档，职责见 Documentation Rules |

## Working Rules

- 改动 TS 代码后：`npm run build && npm test && npm run lint` 三绿才算完成。
- **已验收的 UI 样式（styles.css）与界面结构不得为通过 lint/审核建议而自行调整**——样式类改动仅响应用户明确要求（0.4.1 为消一条 `:has` Warning 改选择器导致按钮布局出错、0.4.2 全量回退的教训）。
- legacy/ 存档已于 0.4.1 删除（社区目录静态扫描全仓库，存档旧代码的告警被误报为插件问题）：需要旧代码参考时从 git 历史（tag 0.4.0 及更早）检出。
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

- 发布渠道：GitHub Releases（lanbinleo/ex-editor），由 GitHub Actions 自动完成（`.github/workflows/release.yml`）：npm ci → build/test/lint → 校验 manifest 版本与 tag 一致 → 生成工件构建来源证明（artifact attestation）→ 创建 Release 并附 `main.js`/`manifest.json`/`styles.css`。**不在本地出包发布**（社区目录要求资产可验证为源码构建）。
- **Release tag 必须与 manifest 版本完全一致且无 `v` 前缀**（Obsidian 社区目录硬性要求，带 v 会被拒："No release matches your manifest version"）。注意 `npm version` 默认自动打 v 前缀 tag——发布时用 `npm version <type> --no-git-tag-version`，手动提交后打 `git tag -a <x.y.z>` 并推送，CI 接管后续。
- Release 说明放 `docs/release-notes/<version>.md`（存在则用作 Release notes，否则 GitHub 自动生成）。
- 社区市场提交流程（2026-10 确认）：经 community.obsidian.md 开发者面板提交（Obsidian 账号登录 + 关联 GitHub 验证仓库所有权），不再是向 obsidian-releases 提 PR；README 已含英文区块。

## Documentation Rules

- 产品决策与能力设计 → `docs/product-design.md`（唯一维护点）
- 未来计划与非目标 → `docs/roadmap.md`
- 当前完成状态与验证记录 → `docs/implementation-status.md`
- 开发流程与版本规则 → `docs/development-workflow.md`
- 外部原始资料 → git 历史中的 legacy/writingbuddy/design/（已删除，tag 0.4.0 及更早可查；保持来源，不当成已确认决策）

## Definition of Done

功能在真实 Obsidian 中可用且：build/test/lint 三绿；文稿修改可撤销且应用前有快照（涉及文稿时）；相关文档已同步；无密钥或运行时数据入库；工作区无未说明的遗留改动。

## Open Decisions

| 事项 | 当前处理 | 何时需要决定 |
|---|---|---|
| 是否发布社区插件市场 | 准备中：v0.4.0 已发 GitHub Release，待经 community.obsidian.md 提交 | 提交审核期间 |
| `main.js` 是否入库 | 入库（构建产物即运行时插件，方便任意 commit 直接可用） | 上 GitHub release 流程时 |
| `isDesktopOnly` | false，但移动端不做测试承诺 | 出现移动端需求时 |
| 闲置段落自动检查默认开关 | 默认关闭（roadmap M5） | M5 实现时 |
