# 贡献指南

本仓库所有改动都必须走「议题 → 分支 → PR → 审查合并」。`main` 分支受 GitHub ruleset 保护（仅 PR 合入、linear history、禁止删除与强推）。

## 1. 流程

1. 先建 Issue，写清动机、范围与验收标准；较大改动在 Issue 里先对齐方案。
2. 从最新 `origin/main` 建 worktree 与分支：`<type>/<issue>-<slug>`（type ∈ feat / fix / docs / chore / test / refactor）。
3. 只改本 Issue 声明的范围，不改无关文件、不顺手重构。
4. 本地跑完第 5 节自检。
5. 提交：`<type>: <中文摘要> (#<issue>)`。
6. 开 PR：base `main`，body 首行 `Closes #<issue>`，附自检命令与输出。
7. 由维护者审查合并。合并后立刻清理远程分支、本地分支与 worktree（见第 4 节）。

## 2. CI 只在构建期运行

- `.github/workflows/build.yml` **只**由 `push tag v*` 与 `workflow_dispatch` 触发；PR 不跑 CI。
- 禁止添加 `pull_request` 或普通 `push` 触发器（仓库硬规则）。
- 正因如此，**合并前的本地自检是硬要求**，维护者会要求贴输出。
- 构建期流水线：`npm install --no-audit --no-fund` → `npm run check` → `npm run build` → `npm pack` → upload artifact。

## 3. 代码规模

- **硬线：单文件 ≤ 1000 行。** 超过 1000 行必须停下来交维护者/用户决定（通常按职责拆文件）。
- 目标：单文件 ≤ 300 行。
- 自检脚本：`node scripts/check-file-lines.mjs`（默认阈值 1000，`--limit N` 可改）；`npm run check` 已包含。
- 扫描范围：`src/`、`tests/`、`scripts/` 下的 `.ts` / `.mjs` / `.js` / `.md`；排除 `node_modules` / `lib` / `dist` / `coverage`。

## 4. 分支、worktree 与构建产物清理

- 并行开发用 worktree 隔离，主 checkout 保持 `main` 干净：

  ```sh
  git worktree add ../.phone-wt/<name> -b <type>/<issue>-<slug> origin/main
  ```

- 合并后清理：`git worktree remove <path>`、`git branch -d <branch>`、`git push origin --delete <branch>`；临时 profile、下载的 scrcpy-server jar、本地安装验证产物用完即删。
- **不提交** `node_modules/`、`lib/`、`dist/`、`*.tgz`、`coverage/`、`assets/scrcpy-server*.jar`（已在 `.gitignore`）。

## 5. 本地自检

```sh
npm install
npm run check                    # typecheck + test + 行数
node scripts/check-file-lines.mjs
npm run build                    # 确认构建通过；产物 lib/ 不提交
```

全部通过才允许开 PR；PR 描述里贴命令与结论。

## 6. 文档与接口

- 文档随代码同 PR 更新：README、`docs/`、配置字段说明、CHANGELOG（若有）。
- `docs/SPEC.md` 是需求原文，**禁止改写**；实现与需求的偏差写进 `docs/` 下的其它文档，并在 PR 说明。
- 依赖、构建、导出（`exports`）的变更必须同步 `package.json`、`package-lock.json` 与本文档。
- DSH 插件 API 以 dsh-plugin-skills 与本机 dsh 源码为准，禁止凭记忆猜签名；未验证项必须显式标注。

## 7. 提交信息与 PR 约定

- 提交：`<type>: <中文摘要> (#<issue>)`。
- PR 标题与主要提交一致；body 首行 `Closes #<issue>`。
- 一次 PR 只做一件事，不混入多个 Issue，不做无关格式化。
- PR 描述包含：改了什么、为什么、自检命令与结果、遗留问题 / 未验证项。

## 8. 安全与红线

- 不安装软件、不修改模拟器自身配置、不自动打开插件开关（SPEC §6.3 / §6.4）。
- `phone_shell` 默认 ask 审批，仅查询类白名单免确认。
- 配置写入遵守 SPEC §6.2 的 R1–R5（定点合并、原文保留、缓存命中、写后双验证、先验证后落盘）。
