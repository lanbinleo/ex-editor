# ExEditor（有经验的编辑）

Obsidian 内的 AI 校对与改稿搭档：像一位有经验的编辑坐在你旁边——**圈出问题、解释原因、给出改法**，也能按你的指令整段重写，并且**绝不弄丢你的稿子**。

本项目是旧插件「编辑建议（editing-suggestions）」的推倒重建：复用其经过单测验证的安全核心，全部 UI 按新架构重写。旧代码存档于 [`legacy/writingbuddy/`](legacy/writingbuddy/)（只读参考）。

## 当前状态：M1 最小安全闭环（v0.2.0，dev 分支待真机验收）

「检查本段落」→ AI 返回建议 → 侧边栏浏览 → 逐条接受/忽略 的最小闭环已可用：

1. 设置 → 第三方插件 → ExEditor：选择预设（DeepSeek / GLM / 自定义）、填写 API 密钥，测试连接
2. 光标放进任意段落，命令面板执行「ExEditor: 检查本段落」（或点击右侧栏 ExEditor 面板中的按钮）
3. 侧边栏列出建议：字符级红删绿增 diff + 分类 + 理由；「接受」单事务替换（Ctrl+Z 可撤销）、「忽略」移除、「定位」跳回原文

安全协议：模型只报「原文片段 + 改法」，插件在文中**唯一定位**后才生效；frontmatter/代码/公式/双链等保护区域绝不改写；原文变了就标记失效丢弃，宁可漏改不可错改。

| 里程碑 | 版本 | 内容 |
|---|---|---|
| M0 | 0.1.0 | 骨架：可加载、构建/测试/lint 管线就绪、文档齐全 ✅ |
| M1 | 0.2.0 | 最小安全闭环：检查本段落 → 侧边栏列表 → 接受/忽略 ✅（待真机验收） |
| M2 | 0.3.0 | 编辑器内波浪线标记、悬浮卡片 |
| M3 | 0.4.0 | 全文检查、进度、可取消、批量操作 |
| M4 | 0.5.0 | 自定义指令、整段重写、快照备份 |
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
