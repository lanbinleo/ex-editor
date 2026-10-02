# ExEditor（有经验的编辑）

Obsidian 内的 AI 校对与改稿搭档：像一位有经验的编辑坐在你旁边——**圈出问题、解释原因、给出改法**，也能按你的指令整段重写，并且**绝不弄丢你的稿子**。

本项目是旧插件「编辑建议（editing-suggestions）」的推倒重建：复用其经过单测验证的安全核心，全部 UI 按新架构重写（旧代码存档于本仓库早期提交，供溯源）。

## English

**ExEditor** is an AI copy editor for Obsidian, built for Chinese-language writers. Like an experienced editor sitting beside you, it **flags problems in your draft, explains why, and proposes fixes** — or rewrites a passage to your instruction — and it **never loses your text**.

- **Proofreading**: check the selection, the current paragraph, or the whole note, with three intensity levels (typos only / grammar, default / deep polish). Multiple checks can run in parallel and are cancelable at any time.
- **Rewrite by instruction**: type a request such as "compress to under 50 characters" and watch a streaming, word-level diff preview (red deletions, green insertions) before anything is applied.
- **Bring your own model**: DeepSeek, Zhipu GLM, OpenAI, or any OpenAI-compatible endpoint. Each provider keeps its own API key, stored locally only, and encrypted on desktop via the system keychain (`safeStorage`).
- **Safety protocol**: a suggestion applies only when its original snippet appears exactly once in the note (otherwise it is dropped as stale — miss a fix rather than fix the wrong spot); frontmatter, code blocks, math, wikilinks, images and callout markers are never touched; batch edits land as a single undoable transaction, and a snapshot is written to `.exeditor/backups/` before any batch apply or rewrite.

Requires Obsidian 1.7.2+. The UI and prompts are in Chinese; documentation below is in Chinese as well.

## 当前状态：M3 修改层次与指令重写（v0.4.0，已发布）

在 M2 三种范围 + 流式反馈之上，新增：

- **检查强度三档**：头部下拉切换「错别字（最小修改）/ 病句（默认）/ 润色（深度）」
- **按指令重写**：侧边栏底部输入要求（如"压缩到 50 字以内"）→ 按范围选择器（选中/段落/全文，默认选中）流式改写 → 红删绿增 diff 预览 → 确认应用（应用前自动快照，Ctrl+Z 可撤销）
- **多提供商模型服务**：DeepSeek / 智谱 GLM / OpenAI 预设 + 自定义 OpenAI 兼容服务，可增删切换；每家独立 API 密钥，桌面端经系统密钥库（safeStorage）加密落盘；模型可从 `/models` 拉取列表点选或手输
- **快照备份**：批量接受/改写/恢复前自动快照到 `.exeditor/backups/`（目录镜像笔记结构），侧边栏可查看、手动备份、恢复；每篇自动保留上限
- **批量接受**：全部建议合并为单事务一次撤销

安全协议：模型只报「原文片段 + 改法」，插件在文中**唯一定位**后才生效；frontmatter/代码/公式/双链等保护区域绝不改写；原文变了就标记失效丢弃，宁可漏改不可错改；批量修改与重写应用前必先快照。

| 里程碑 | 版本 | 内容 |
|---|---|---|
| M0 | 0.1.0 | 骨架：可加载、构建/测试/lint 管线就绪、文档齐全 ✅ |
| M1 | 0.2.0 | 最小安全闭环：检查本段落 → 侧边栏列表 → 接受/忽略 ✅ |
| M2 | 0.3.0 | 检查范围（段落/选中/全文）、流式、可取消、动效、按文件并行（计费已于 M3 后期移除） ✅ |
| M3 | 0.4.0 | 检查强度三档、按指令重写（流式实时 diff 预览）、范围统一（默认选中、改写跟随）、多提供商与独立密钥加密、快照备份、批量接受 ✅ |
| M4 | 0.5.0 | 编辑器内波浪线标记、悬浮卡片 |
| M5 | 0.6.0+ | 闲置自动检查、性能与发布打磨 |

## 开发

本仓库位于 vault 的 `.obsidian/plugins/exeditor/`，构建产物 `main.js` 即运行时插件（原地开发，无需部署脚本）。

```bash
npm install        # 安装依赖
npm run dev        # esbuild 监听模式（配合 Obsidian 热重载）
npm run build      # 类型检查 + 生产构建
npm test           # vitest 单测
npm run lint       # eslint（含 obsidianmd 规则集）
```

在 Obsidian 中启用：设置 → 第三方插件 → 关闭安全模式 → 启用「ExEditor」。修改 `manifest.json` 的 id/name 后需重启 Obsidian。

建议安装 [hot-reload](https://github.com/pjeby/hot-reload) 插件实现保存即重载（要求插件目录是 git 仓库，本项目已满足）。

## 文档入口

- [docs/product-design.md](docs/product-design.md) — 产品定位、能力与安全协议设计
- [docs/roadmap.md](docs/roadmap.md) — 里程碑路线图与非目标
- [docs/implementation-status.md](docs/implementation-status.md) — 当前进度与验证记录
- [docs/development-workflow.md](docs/development-workflow.md) — 开发循环、分支与版本流程
- [AGENTS.md](AGENTS.md) — 面向编码 Agent 的项目事实与约束

## 致谢

- 项目骨架源自 [obsidian-sample-plugin](https://github.com/obsidianmd/obsidian-sample-plugin)（0-BSD）
- 安全核心（唯一定位协议、保护区域、单事务应用）移植自旧项目「编辑建议」
