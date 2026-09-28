# 开发流程 — ExEditor

## 环境

- Node.js LTS + npm；Obsidian 桌面版，vault：`D:\Desktop\写作人生`
- 本仓库位于 `vault/.obsidian/plugins/exeditor/`，`npm run build` 产出的 `main.js` 就是 Obsidian 加载的插件，**原地生效，无部署步骤**

## 日常开发循环

```bash
npm run dev     # esbuild watch：保存即重新打包
```

配合 Obsidian 侧重载（三选一）：

1. **推荐**：安装 [hot-reload](https://github.com/pjeby/hot-reload) 插件——`main.js` 变更自动重载插件（要求插件目录为 git 仓库，本项目满足）
2. 命令面板 → 「Reload app without saving」
3. 设置 → 第三方插件 → 关闭再开启 ExEditor

注意：修改 `manifest.json`（id/name/minAppVersion）后必须完全重启 Obsidian。

## 提交前检查

```bash
npm run build   # 类型检查 + 生产构建
npm test        # 单测
npm run lint    # eslint
git status      # 确认无 data.json / node_modules / *.map 混入
```

三条命令全绿 + 真机验证相关交互（详见 AGENTS.md Verification）后才算完成。

## 分支模型

- `main`：稳定、可真机验证的状态；里程碑完成时合并
- `dev/x.y.z`：一个里程碑（如 `dev/0.2.0`）的持续开发
- `feat/<name>` / `fix/<name>` / `docs/<name>`：从当前 dev 分支拉出的短命分支，完成即合

## 提交规范

Conventional Commits：`feat:` / `fix:` / `docs:` / `chore:` / `test:` / `refactor:`，描述可中文。一次提交一个意图。

## 版本与里程碑流程

1. 里程碑全部验收项通过 → `npm version minor`（自动同步 `manifest.json` 与 `versions.json`）
2. 更新 `docs/implementation-status.md`（能力、验证记录、限制）与 `docs/roadmap.md`（勾选里程碑）
3. dev 分支合入 `main`
4. M4 起旧插件 editing-suggestions 停用前，先确认快照/恢复功能可用
