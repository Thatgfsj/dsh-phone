# AGENTS.md —— 给 AI 代理的仓库级硬规则

本文件对所有在本仓库工作的 AI 代理（以及人类贡献者）生效；与 README / CONTRIBUTING 冲突时以更严格者为准。

## 必须遵守

1. **议题 + PR**：任何仓库改动都必须先有 Issue，再建分支/worktree，开 PR 交维护者审查合并。禁止直接 push `main`、禁止自己合并 PR、禁止强推或删除 `main`。
2. **只改本 Issue 的 scope**：不碰其它 Issue 的文件（并行代理各自用 worktree）；需要接口变更先与 Lead / 维护者确认。
3. **CI 只在构建期**：workflow 只允许 `v*` tag 与 `workflow_dispatch` 触发；禁止添加 `pull_request` 或普通 `push` 触发器。
4. **单文件 ≤ 1000 行**（硬线，超过 1000 必须交用户决定）；目标 ≤ 300 行/文件，按职责拆分。
5. **分支 / worktree / 构建产物及时清理**：不提交 `node_modules/`、`lib/`、`dist/`、`*.tgz`、`coverage/`、`assets/scrcpy-server*.jar`；合并后删远程分支、本地分支与 worktree；临时 profile 用完即删。
6. **文档随代码同 PR 更新**：README / `docs/` / 配置字段说明。
7. **DSH 插件依赖红线**：宿主共享的 `@deepseek-ai/*` 包只能放 `peerDependencies` + `devDependencies`，**禁止**放 `dependencies`；`engines.dsh` 必须覆盖支持的 DSH 版本区间（当前 `>=0.2.1-rc.2 <0.3.0`）；只要包里有 `exports`，就必须显式导出 `./package.json` 与 `./locale/*.json`，否则图标与标题静默失效。
8. **交付前自检**：`npm install`、`npm run check`、`node scripts/check-file-lines.mjs`、`npm run build` 全部通过，并在 PR/汇报里贴命令与输出。
9. **不使用未验证的 API**：DSH 插件 API 以 dsh-plugin-skills 与本机 dsh 源码为准，禁止凭记忆猜签名；未验证项在文档中标注"未验证"。
10. **安全红线**：不安装软件、不修改模拟器参数、不自动打开插件开关、`phone_shell` 走审批、配置写入遵守 SPEC §6.2 的 R1–R5。

## 提交与 PR

- 提交信息：`<type>: <中文摘要> (#<issue>)`。
- PR body 首行：`Closes #<issue>`。
- PR 描述必须包含：改了什么、为什么、自检命令与结果、遗留问题 / 未验证项。

## 并行协作

- 每个 teammate 使用独立 worktree（`/home/thatgfsj/AIagent/.phone-wt/<name>`），只在自己的 worktree 编辑。
- 共享任务板上的 `writeScopes` 是边界；越界前先与 Lead 确认。
- 不提交任何构建产物或下载缓存；收工前确认 `git status` 干净。
