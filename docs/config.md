# 配置参考（SPEC §6.1）

> 配置节点：`dsh-phone`。字段默认值与 SPEC §6.1 一致；变更权与落盘方式见下文。
> 架构与写入机制见 [architecture.md](architecture.md) §2、[calibration.md](calibration.md) §2；首次使用守卫见 [usage.md](usage.md) §1。

## 1. 配置从哪来、写到哪去

- 插件通过 Schemastery `Config` 声明字段，DSH Loader 在加载时校验并注入 `apply(ctx, config)`。
- **volatile 字段**（`attach.endpoint` / `attach.userHint` / `attach.resolved` / `onboarding.status` / `onboarding.choice`）：
  可被设置页/接入流程/首次使用引导实时修改；写入走 `ctx.settings.mutate('dsh-phone', ops, revision)`，
  由 DSH `configEditor` 用 YAML Document 保留注释/顺序、原子写、失败回滚。
  volatile 更新**不重跑 `apply`**，插件每次通过 `config.attach.*.get()` / `config.onboarding.*.get()` 读取最新值。
- **非 volatile 字段**（其余全部）：改动会触发该配置行重载（`apply` 重新执行）。
- 落盘文件：`$DSH_HOME/profiles/<profile>/cordis.patch.yml`（`$DSH_HOME` 默认 `~/.dsh`）。
  插件**不直接读写**该文件；不要手工编辑它来写 volatile 字段（会绕过 revision/R4/R5）。
- 配置命名空间 = profile 行 id = 包名 `dsh-phone`。

## 2. 全量字段

```yaml
dsh-phone:
  enabled: true                  # 插件总开关（仅用户；非 volatile）
  runtime: auto                  # auto | redroid | emulator | attach（仅用户；非 volatile）
  onboarding:                    # 首次使用守卫（issue #30）
    status: pending              # pending | accepted | declined（volatile）
    choice: ""                   # "" | emulator | redroid | attach（volatile）
  attach:
    endpoint: ""                 # volatile；接入验证后由 Agent/设置页单键写入
    userHint: ""                 # volatile；用户在设置页写，原文永久保留（R2）
    resolved: false              # volatile；缓存锚点（R3），重置权属用户
  redroid:
    image: redroid/redroid:14-latest
    memLimit: 2g
    vcpuLimit: 2
  emulator:
    avdName: ""                  # 空 = 首次自动创建
    resolution: 720x1280
  stream:
    maxSize: 720
    maxFps: 15
    bitrate: 2000000
  lifecycle:
    idleTimeoutMs: 1200000       # running → paused（20 分钟；issue #67 从 5min 调大，暂停恢复也要 ~10-20s）
    pausedTimeoutMs: 1800000     # paused → stopped（30 分钟）
    prewarm: false               # 插件加载后预热拉起实例（#67；默认 false，面板打开/首次调用才启动）
  limits:
    maxInstances: 1              # 首版固定单实例
```

| 字段 | 类型 | 默认值 | volatile | 变更权 | 说明 |
|---|---|---|---|---|---|
| `enabled` | boolean | `true` | 否 | 用户 | 关闭后只注册只读 `GET /config`，不注册工具/视频流 |
| `runtime` | enum | `auto` | 否 | 用户 | 显式值跳过 auto 决策树；Agent 不得自行改 |
| `onboarding.status` | enum | `pending` | 是 | 用户 / Agent（经用户同意） | `pending｜accepted｜declined` |
| `onboarding.choice` | enum | `""` | 是 | 用户 / Agent（经用户同意） | `""｜emulator｜redroid｜attach`；accepted 且非空时等价显式 `runtime` |
| `attach.endpoint` | string | `""` | 是 | Agent 接入流程 / 用户设置页 | 形如 `127.0.0.1:5555` |
| `attach.userHint` | string | `""` | 是 | **仅用户** | 一句话原文；Agent 通道写它返回 403 |
| `attach.resolved` | boolean | `false` | 是 | 用户重置 / Agent 接入流程 | `true` 时跳过重新探测（R3） |
| `redroid.image` | string | `redroid/redroid:14-latest` | 否 | 用户 | redroid 镜像 |
| `redroid.memLimit` | string | `2g` | 否 | 用户 | `docker run --memory` |
| `redroid.vcpuLimit` | number | `2` | 否 | 用户 | `docker run --cpus` |
| `emulator.avdName` | string | `""` | 否 | 用户 | 空则按 `-list-avds` 首个；仍无则尝试创建 |
| `emulator.resolution` | string | `720x1280` | 否 | 用户 | 传给 emulator `-skin` |
| `stream.maxSize` | number | `720` | 否 | 插件（用户可改配置） | scrcpy `max_size` |
| `stream.maxFps` | number | `15` | 否 | 插件（用户可改配置） | scrcpy `max_fps` |
| `stream.bitrate` | number | `2000000` | 否 | 插件（用户可改配置） | scrcpy 视频码率（bps） |
| `lifecycle.idleTimeoutMs` | number | `1200000` | 否 | 用户 | 20 分钟无交互 → paused（issue #67；观看视频也算交互） |
| `lifecycle.pausedTimeoutMs` | number | `1800000` | 否 | 用户 | paused 30 分钟 → stopped |
| `lifecycle.prewarm` | boolean | `false` | 否 | 用户 | 插件加载后预热启动（需 onboarding accepted；加速首次点击，代价是常驻内存） |
| `limits.maxInstances` | number | `1` | 否 | 固定 | 首版单实例 |

## 3. 按场景修改

### 3.1 设置页（volatile 五键）

「设置 → 手机」可：
- **首次使用卡片**（pending/declined 时显示）：选择 Android SDK Emulator / redroid / 连接已有实例 /
  暂不使用；选择后写 `onboarding.choice` 与 `onboarding.status`（拒绝写 `declined`），
  并展示安装命令与体积——**插件不代装**；卡片可把 `status` 重新写回 `pending` 重新打开引导。
- 编辑并保存「一句话」→ 写 `attach.userHint`；
- 查看 `attach.endpoint` / `attach.resolved` 状态；
- 「重置解析」→ 写 `attach.resolved: false`（用户点击确认，Agent 不会调用）；
- 「打开手机面板」→ 打开右侧栏 tab（不自动弹）。

写入失败时的错误码见 [troubleshooting.md](troubleshooting.md) §4（`E_CONFIG_CONFLICT` 会自动刷新 revision 重试一次）。

### 3.2 接入流程（Agent 通道）

R5 验证通过后，用 `POST /dsh-phone/api/agent/config` 单键写 `attach.endpoint` 与 `attach.resolved`
（**revision 必填**，先 `GET /config` 取 revision；endpoint 仅 loopback、端口 ≥1024，verify 记录 TTL 5 分钟）。
Agent 通道**不得**写 `attach.userHint` 或 `onboarding.*`（403 `E_FORBIDDEN`，issue #71 防自我授权）；
首次使用守卫的同意/选择只能由用户在浏览器设置页/引导卡片完成。
完整命令见 [usage.md](usage.md) §1.2/§4 与 README「首次接入」。

### 3.3 首次使用守卫（onboarding，issue #30）

| 状态 | 行为 |
|---|---|
| `pending`（默认） | 所有 `phone_*` 工具（含 `phone_status`）返回 `E_ONBOARDING_REQUIRED`（带 `onboarding` 引导 JSON）；**不启动运行时、不安装软件、不写配置**；`GET /status` 返回 200 + 同一结构化错误 |
| `declined` | 工具返回 `E_ONBOARDING_DECLINED`；设置页可重新打开引导 |
| `accepted` + `choice` 非空 | 等价显式 `runtime = choice`（优先于 `runtime` 配置，跳过 auto 决策树） |
| `accepted` + `choice` 为空 | 沿用 `runtime` 配置（`auto` 或显式值） |

- 升级前没有 `onboarding` 段的旧配置由 schema 默认值补为 `pending`（升级后首次会询问一次）。
- Agent 只应在用户**明确答复**后写这两个键（先 `choice` 后 `status=accepted`）；用户拒绝写 `declined` 并停止。
- 清空/重开：把 `onboarding.status` 写回 `pending`（保留 `choice` 亦可）；重置权属用户，Agent 不主动重置。

### 3.4 其它字段（enabled / runtime / redroid / emulator / stream / lifecycle）

这些字段非 volatile，改完需要让该配置行重载：

- 推荐：用 DSH 的插件/配置编辑能力修改 `dsh-phone` 行配置（若你的 DSH 页面提供原生配置编辑器）；
- 或手工在 profile 的 `cordis.patch.yml` 中覆盖该行后重启 DSH。**注意：patch 会整体替换该行的 `config`，若手工覆盖必须重述所有需要的键**，否则丢失默认值/其它键。

示例（只改 stream 时，其余键按需重述）：

```yaml
- id: dsh-phone
  config:
    stream:
      maxSize: 540
      maxFps: 15
      bitrate: 1500000
```

> 该行会**整体替换** bundle 层里 dsh-phone 的 config；未写的键会回到 schema 默认值。
> 若你只是想让画面更省资源，优先在设置页之外用 DSH 提供的配置界面，或保持默认。

### 3.5 关闭插件（`enabled: false`）

- 设置页表单只展示 volatile 字段；`enabled` 为**只读展示**（#52/#39），没有可编辑开关（与 SPEC §2 的描述存在差异，见下）。
- 推荐用 DSH「插件管理」禁用 `dsh-phone` 行（Loader `disabled`），等效于不加载插件；
- 或在 profile patch 中把该行 `config.enabled` 设为 `false` 并重载（同样注意 patch 整体替换）。
- 关闭后：不注册 9 个工具与视频流；`GET /dsh-phone/api/config` 仍只读可用；已写入的 `attach.*` / `onboarding.*` 保留，重新开启后按原状态继续。

## 4. 环境变量

| 变量 | 作用 | 默认 |
|---|---|---|
| `DSH_HOME` | DSH 数据根；Agent token 文件位于 `<DSH_HOME>/storages/dsh-phone/agent.json` | `~/.dsh` |
| `DSH_PHONE_SCRCPY_SERVER` | 覆盖 scrcpy-server jar 路径 | `<包目录>/assets/scrcpy-server.jar` |

## 5. Agent token 文件

```json
{
  "token": "<64 位十六进制>",
  "baseUrl": "http://127.0.0.1:3080"
}
```

- 路径：`$DSH_HOME/storages/dsh-phone/agent.json`，目录 0700、文件 0600。
- 插件加载时生成，卸载/重载时删除并轮换；旧 token 立即失效。
- 仅当请求来自 loopback、无 `Origin` 头且 `x-dsh-phone-token` 匹配时才绕过浏览器同源校验。
- **不要**把 token 贴进公开日志/issue；它等价于本机配置写权限。

## 6. 与 SPEC 的差异（实现为准）

1. **新增首次使用守卫**（SPEC 未描述）：`onboarding.status/choice` 两个 volatile 键；pending 时工具一律返回
   `E_ONBOARDING_REQUIRED`，用户明确同意后才允许操作（issue #30）。
2. **设置页只读展示 `enabled`**（#52/#39）：设置表单仍只展示 volatile 字段；开关请用插件管理或 profile 配置（见 §3.5）。
3. **一句话候选路径/端口探测由操作 Agent 的 shell 完成**，插件只提供 `/attach/verify` 与单键写入（见 [host.md](host.md) §6）。
4. **`cpuPct/memPct` 为尽力而为**（#56）：`PhoneStatus` 中为可选字段，emulator/redroid/attach 各自采样，取不到就缺省。
5. **Agent 通道不提供 `GET /config`**：读取 `userHint` 用 `dsh --profile <p> --dump-config`（只读）；onboarding 状态从工具错误体读取。