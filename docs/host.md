# Host 半边设计（#4）

> 状态：已实现并通过 `npm run check` / `npm run build`。契约以 [docs/architecture.md](architecture.md)
> [docs/protocol.md](protocol.md) [docs/calibration.md](calibration.md) 为准；本文记录实现细节、
> 与冻结契约的**有意偏差**、以及尚未验证的项。

## 1. 模块图

```
src/index.ts                 函数插件入口：name / inject=['tools'] / Config / apply
├── src/config/schema.ts     SPEC §6.1 全量 Schemastery（attach 三叶 volatile）
├── src/config/write.ts      唯一写路径 ctx.settings.mutate（R1/R4，冲突重试一次）
├── src/phone/
│   ├── service.ts           PhoneService：生命周期编排/单飞/串行队列/流引用计数/控制通道
│   ├── wiring.ts            真实依赖装配：runtime detect/adb + stream/index.ts + PhoneLifecycle
│   └── contracts.ts         工具层消费的窄接口（PhoneOperations / AttachmentsLike）
├── src/tools/
│   ├── index.ts             9 个工具工厂汇总 + 注册
│   ├── common.ts            统一成功/失败体、E_BOOTING 中间态、错误映射、render
│   ├── shell-policy.ts      phone_shell 白名单 + ask 决策（纯函数）
│   └── {status,screenshot,tap,swipe,key,input-text,app-launch,uiautomator-dump,shell}.ts
├── src/http/
│   ├── routes.ts            GET/POST /dsh-phone/api/{status,config,attach/verify,screenshot}
│   ├── auth.ts              ctx.connection.requestRejection → 401/403/503
│   └── json.ts              {ok,value} / {ok,error} 统一响应、no-store、请求体解析
└── src/stream/index.ts      消费方（stream #5）：startStream/startControlOnly/createStreamUpgradeRoute
```

Host 不直接读写 `cordis.patch.yml`，不自行实现 runtime/收流；runtime/stream 的源码行数见各自 PR。

## 2. 配置（SPEC §6.1）

`src/config/schema.ts` 导出 `Config`（Schemastery）与 `PhoneConfig = ReturnType<typeof Config>`。

| 字段 | 默认值 | volatile | 说明 |
|---|---|---|---|
| `enabled` | `true` | ❌ | 插件总开关；变更权仅用户，重载后 apply 决定是否注册工具 |
| `runtime` | `auto` | ❌ | auto/redroid/emulator/attach；Agent 不得自行修改 |
| `attach.endpoint` | `""` | ✅ | 接入助手验证后单键写入 |
| `attach.userHint` | `""` | ✅ | 用户一句话，原文永久保留（R2） |
| `attach.resolved` | `false` | ✅ | 解析完成哨兵（R3；重置权属用户） |
| `redroid.image` | `redroid/redroid:14-latest` | ❌ | |
| `redroid.memLimit` | `2g` | ❌ | |
| `redroid.vcpuLimit` | `2` | ❌ | |
| `emulator.avdName` | `""` | ❌ | 空则首次自动创建 |
| `emulator.resolution` | `720x1280` | ❌ | |
| `stream.maxSize/maxFps/bitrate` | `720/15/2000000` | ❌ | 归插件管，Agent 不调整 |
| `lifecycle.idleTimeoutMs` | `300000` | ❌ | running→paused |
| `lifecycle.pausedTimeoutMs` | `1800000` | ❌ | paused→stopped |
| `limits.maxInstances` | `1` | ❌ | 首版单实例 |

### 2.1 写入路径（R1–R5）

- **唯一写 API**：`ctx.settings.describe('dsh-phone')` 取 revision →
  `ctx.settings.mutate('dsh-phone', [{op:'set',path,value}], revision)` → 再次 describe 回读比对（R4a）。
  dsh-settings 内部经 configEditor 用 YAML Document 保注释/顺序、原子写、失败回滚；本插件**禁止**
  自行读写 `cordis.patch.yml`（calibration §2.3）。
- **只允许三个键**：`attach.endpoint` / `attach.resolved` / `attach.userHint`（R1）。其它路径返回
  `400 E_BAD_PATH`，不会调用 mutate。
- **冲突**：revision 不匹配时重新 describe 后用新 revision 重试一次；再次冲突返回
  `409 E_CONFIG_CONFLICT`（retryable=true），由客户端刷新后重试。
- **R5 先验证后落盘**：`POST /attach/verify` 成功的 endpoint 才被记入进程内 `verified` 集合；
  写 `attach.endpoint` 或 `resolved=true` 前检查该集合，否则 `409 E_NOT_VERIFIED`。verify 本身不写配置。
- **R4b 写完复验**：写 endpoint / resolved=true 成功后，路由调用 `service.ensureRunning()`
  并取 `phone_status`；非 running 返回 `502 E_DEVICE_DISCONNECTED`（retryable=true）。
  注意：此时配置**可能已经落盘**——错误体 message 明确说明，便于操作 Agent 汇报。
- 写后回读不一致（R4a 失败）返回 `500 E_DEVICE_COMMAND`（retryable=true）。
- **写入通道**：浏览器设置页走 `POST /config`（connection 同源鉴权）；操作 Agent 走
  `POST /agent/config`（本地 token，见 §5.2）。二者都收敛到 `writeConfigValue`。

## 3. 9 个工具（SPEC §4，名称/参数严格一致）

| 工具 | 参数 | 要点 |
|---|---|---|
| `phone_status` | — | 任何任务第一步；`isConcurrencySafe:()=>true`；返回 state/runtime/platform/cpuPct/memPct/uptimeMs/bootMs/endpoint |
| `phone_screenshot` | — | `attachments.saveImage` → `[{type:'text'},{type:'image'}]`；附件缺失/失败/超限降级文本，不整体失败 |
| `phone_tap` | `x,y` (integer, required) | 坐标必须来自截图/控件树；描述写明前置条件 |
| `phone_swipe` | `x1,y1,x2,y2,durationMs` | 同上 |
| `phone_key` | `name` (string) | HOME/BACK/RECENTS/ENTER/DEL… → keyevent |
| `phone_input_text` | `text` (string) | 走 `PhoneService.inputText` → scrcpy INJECT_TEXT；**禁止 shell input text**（中文） |
| `phone_app_launch` | `pkg` (string) | monkey LAUNCHER intent |
| `phone_uiautomator_dump` | — | 控件树 XML；与截图双通道校验 |
| `phone_shell` | `cmd` (string) | 默认 ask；白名单 `getprop` / `wm size` / `dumpsys` 只读 service 免确认 |

统一执行骨架（`src/tools/common.ts`）：

1. `service.ensureInteractive()`：stopped/paused → 懒启动并阻塞；已在 booting → **立即**返回
   `{ok:false, code:'E_BOOTING', bootMs, retryable:true}`（不抛错，SPEC §3.4）；
2. 执行设备动作；
3. 异常 → 结构化错误（runtime 不可用带安装指引；超时可重试；其余 `E_DEVICE_COMMAND`）。

### 3.1 phone_shell 审批

`src/index.ts` 顶部注册 `tools/pre-execute` waterfall：`exec.name==='phone_shell'` 且
`evaluateShellCommand(cmd)` 非白名单 → 返回 `{kind:'ask', reason, displayReason:{en,zh}}`。
白名单判定在 `shell-policy.ts`（纯函数）：拒绝 shell 元字符（`; | & < > $ ` ( ) { } [ ]`、换行），
`getprop [name]`、`wm size`、`dumpsys <只读 service> [args]`。`dumpsys` service 子集：
activity/window/display/battery/cpuinfo/meminfo/gfxinfo/input/power/wifi。

## 4. PhoneService（INTERFACES §3）

- **懒启动**：构造时不触达外部资源；首次工具/路由调用才 `ensureRunning`。
- **单飞**：`#ensurePromise` 复用 in-flight；生命周期状态机由 runtime `PhoneLifecycle` 经
  `createLifecycle` 注入（host 不复制 state.ts/idle.ts 实现）。
- **booting 中间态**：`ensureInteractive()` 在 state=booting 时立即返回 `{state:'booting', bootMs}`。
- **串行队列**：screenshot 与全部设备 shell 命令共享一条 promise 队列，同一时刻最多 1 个 `screencap`。
- **视频流引用计数**：`startStream(sink)` 首个 viewer 调用 stream `startStream`；release 后 5s 宽限关流
  （测试可注入 `schedule`）；新 viewer 取消宽限并替换旧会话。
- **控制通道**：`inputText/touch` 优先复用活动视频会话的 controller；无 viewer 时经
  `startControlOnly`（只建 control socket，不编码视频）——满足 SPEC §3.6「无人看不开流」。
- **断连**：`AdbConnection.disconnected` → 关闭会话 + `lifecycle.notifyDisconnected` → state=stopped，
  下次交互自动重连。
- **状态事件**：`onStateChange(fn)` 由生命周期 onChange 映射成 `PhoneStatus`。
- **资源**：`dispose()` 逆序关流→断 ADB→释放生命周期；`ctx.effect` 保证卸载回收。
- **配置实时读**：每次从 `deps.config()` 读 volatile 最新值（`.get()`），不缓存快照。

## 5. HTTP 路由（docs/protocol.md 冻结）

前缀 `/dsh-phone/api`，所有请求先 `ctx.connection.requestRejection(req)`：

| 方法/路径 | 行为 |
|---|---|
| GET `/status` | `service.status()`；no-store |
| GET `/config` | `{runtime, attach:{endpoint,userHint,resolved}, stream:{maxSize,maxFps,bitrate}, revision}`；revision 来自 settings.describe（缺失 settings → 503 E_NO_WEB） |
| POST `/config` | body `{path:string[], value, revision?}`；只允许三键；R5 检查；写后回读 + 复验；成功返回同上 snapshot |
| POST `/attach/verify` | body `{endpoint}`；adb connect(timeout 3000) + `getprop ro.product.model`；成功 200 `{ok:true,latencyMs,banner}`，失败 200 `{ok:false,latencyMs,error}`；不落盘 |
| GET `/screenshot` | `image/png` + no-store；booting → 200 JSON `E_BOOTING`（error.bootMs） |

- `enabled=false` 时**只**注册 GET /config（设置页只读）；其余路径 403 `E_NO_WEB`，不注册工具与流。
- 无 `ctx.connection` → 503 `E_NO_WEB`；`requestRejection` 401 → `E_AUTH`，其它 → `E_ORIGIN`。
- WS `/dsh-phone/stream` 用 stream 的 `createStreamUpgradeRoute({service, getConnection, getStreamOptions})`
  注册；鉴权在 factory 内用注入的 `ctx.connection` 完成。

### 5.1 本地 Agent 通道（SPEC §5.2 步骤 6 补位）

操作 Agent 只有 shell/文件工具，拿不到浏览器 cookie，无法通过 `ctx.connection` 同源鉴权调用
`POST /config`。Host 因此在 apply 时生成随机 token 并落盘：

- 文件：`$DSH_HOME/storages/dsh-phone/agent.json`（权限 0600；`DSH_HOME` 空则 `~/.dsh`），内容
  `{"token":"<64 hex>","baseUrl":"http://127.0.0.1:<port>"}`；`baseUrl` 取自 `ctx.webServer.getOrigin()`。
- 路由：`POST /dsh-phone/api/agent/config`，body 与 `POST /config` 相同（`{path,value,revision?}`，
  仍只允许 `attach.endpoint｜resolved｜userHint` 三键）。
- 鉴权：**同时满足** ① `req.socket.remoteAddress` 为 loopback（127/8、::1、::ffff:127/8）；
  ② 无 `Origin` 头；③ `x-dsh-phone-token` 与文件 token 常量时间相等。任一不满足则回退
  `ctx.connection.requestRejection` 的原有校验；token 错误且无同源 cookie → 401 `E_AUTH`。
- R5/R4 不因通道变化：未 verify 的 endpoint 仍 409 `E_NOT_VERIFIED`；写后仍 describe 回读 + phone_status 复验。
- **R2 收口**：`/agent/config` **禁止写 `attach.userHint`**（返回 403 `E_FORBIDDEN`，不落盘）——
  一句话原文只由用户在设置页修改；浏览器 `POST /config` 仍允许写 userHint。
- 清理：插件 dispose（卸载/重载）时删除 token 文件；重载会生成新 token（旧 token 立即失效）。

Agent 侧标准流程（docs 片段，也写进 README）：

```sh
BASE=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.env.HOME+'/.dsh/storages/dsh-phone/agent.json','utf8')).baseUrl)")
TOKEN=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.env.HOME+'/.dsh/storages/dsh-phone/agent.json','utf8')).token)")
# 1) 先验证（R5，不落盘）；成功才继续
curl -sS -X POST "$BASE/dsh-phone/api/attach/verify" -H 'content-type: application/json' \
  -H "x-dsh-phone-token: $TOKEN" -d '{"endpoint":"127.0.0.1:5555"}'
# 2) 写 endpoint 与 resolved（R1 两个单键；会被 R4/R5 校验）
curl -sS -X POST "$BASE/dsh-phone/api/agent/config" -H 'content-type: application/json' \
  -H "x-dsh-phone-token: $TOKEN" -d '{"path":["attach","endpoint"],"value":"127.0.0.1:5555"}'
curl -sS -X POST "$BASE/dsh-phone/api/agent/config" -H 'content-type: application/json' \
  -H "x-dsh-phone-token: $TOKEN" -d '{"path":["attach","resolved"],"value":true}'
# 3) 复验 phone_status（R4b）
curl -sS "$BASE/dsh-phone/api/status" -H "x-dsh-phone-token: $TOKEN"
```

> 注意：`verify` 成功只记录在进程内 verified 集合；若插件重载，需重新 verify。
> 候选路径/端口探测仍由操作 Agent 的 shell 完成（插件不扫盘，见 §6.1）。

### 5.2 Host 层错误码映射

| 场景 | HTTP | code | retryable |
|---|---|---|---|
| connection 缺失 / settings 缺失 / 插件关闭时的非 config 路由 | 503 / 403 | `E_NO_WEB` | false |
| 未认证 / 跨站 | 401 / 403 | `E_AUTH` / `E_ORIGIN` | false |
| JSON/字段/endpoint 格式非法 | 400 | `E_BAD_REQUEST` | false |
| 配置路径不在三键白名单 | 400 | `E_BAD_PATH` | false |
| revision 冲突（重试一次后） | 409 | `E_CONFIG_CONFLICT` | true |
| 写 endpoint/resolved 前未 verify | 409 | `E_NOT_VERIFIED` | false |
| Agent 通道试图写 userHint（R2） | 403 | `E_FORBIDDEN` | false |
| 写后 phone_status 复验失败 | 502 | `E_DEVICE_DISCONNECTED` | true |
| 回读校验失败 / 设备命令失败 | 500 | `E_DEVICE_COMMAND` | true |
| 实例启动中（screenshot 路由） | 200 | `E_BOOTING`（带 bootMs） | true |

工具层错误：`E_BOOTING`（带 bootMs）、`E_RUNTIME_UNAVAILABLE`（带安装指引 hints，不可重试）、
`E_TIMEOUT`、`E_DEVICE_COMMAND`。

## 6. 与 architecture.md / SPEC 的偏差（有意，需 Lead 知悉）

1. **不实现 `src/tools/attach.ts`（一句话→候选路径/端口自动探测）**。
   按 #4 任务指令第 8 条：候选路径/端口探测由**操作 Agent 的 shell**完成，插件不扫盘；
   Host 只提供 `POST /attach/verify`（connect + getprop）、`POST /agent/config`
   （本地 token 写入，SPEC §5.2 步骤 6）与浏览器 `POST /config`。SPEC §5.2 的路径/端口候选表
   由 Agent 侧执行，Host 不落地。
2. **Host 不复制状态机**：idle/paused 计时与 booting 状态由 runtime `src/phone/state.ts`
   （内部使用 `idle.ts` 的 `IdleTimer`）提供，经 `createLifecycle` 注入 PhoneService；
   host 侧没有 `src/phone/idle.ts`（该文件归 runtime）。
3. **viewer 引用计数在 Host PhoneService**，不直接用 stream 的 `StreamSession`：
   `phone_input_text/touch` 需要与视频会话共享同一个 controller；stream 的 `StreamSession`
   不暴露 handle。strea 层仍负责 scrcpy 生命周期/封帧/WS。若未来需要多 viewer 共享，
   可改为 stream `StreamSession` + 暴露 controller 的工厂。
4. **POST /config 的成功体**严格是 protocol 的 config snapshot；R4b 失败用错误体而不是附加字段。
5. **`cpuPct/memPct` 未实现**：`PhoneStatus` 中为可选字段，当前始终缺省（无可靠的宿主侧采样
   实现；SPEC §3.7 仅作为参考预算）。标为未实现，不是未验证。
6. **phone_screenshot 的模型图片能力**：只捕获 `attachments.saveImage` 的失败并降级文本，
   未复刻官方 `assertImageCapableRoute`（无法从插件侧访问该内部函数）——见 §7 未验证项。

## 7. 未验证项

1. **真机/模拟器端到端**：本机无 Docker、无 emulator 二进制/AVD、attach 端口不可达。runtime 的
   detect/redroid/emulator，以及 scrcpy pushServer/视频流均只有单测，未实跑。
2. **`ctx.settings.mutate` 的 volatile 热更新端到端**：单测用假 settings 覆盖了 describe/mutate/
   revision 冲突/回读，但未在真实 profile 上验证「写入后插件读到新值_且配置行不重载」。
3. **`ctx.connection.requestRejection` 在自定义 prefix 路由/upgrade 的真实行为**：只按
   calibration §3 的类型与 inspector 样例接线，未在真实 Web 会话验证 401/403。
4. **`attachments.saveImage` 端到端图片内容块**：未在真实会话验证模型路由接受 image block；
   降级路径已单测。
5. **phone_shell ask 的真实审批 UI 往返**：waterfall 返回 ask 的代码路径已单测（纯函数），
   但未在真实审批 UI 点击「允许一次」。
6. **`ctx.inject(['webServer'])` 在无 web carrier 的 profile**：插件应继续提供工具而不注册 HTTP；
   未在 headless profile 实跑（本机仅 web profile）。
7. **enabled=false 只读路由**：单测覆盖 read-only handler 的鉴权/快照语义（通过 routes 假依赖），
   未在真实设置页验证。
8. **本地 Agent 通道端到端**：token 生成/0600/常量时间比较/loopback+无 Origin 判定均有单测；
   但未在真实 dsh Web 进程上验证 `ctx.webServer.getOrigin()` 返回值与真实 socket 的 remoteAddress
   形态（IPv4-mapped 等），也未验证卸载后 token 文件确实被删除。
9. **`x-dsh-phone-token` 与同源 cookie 并存**：token 缺失但同源 cookie 有效时走普通 requestRejection
   分支放行（与浏览器 `POST /config` 等价），该分支只做了单测。

## 8. 自检

```sh
cd /home/thatgfsj/AIagent/.phone-wt/host
npm run check     # tsc --noEmit + node --test（155 tests，含 runtime/stream）+ 行数 72 文件
npm run build     # host=46 files，产物 lib/ 不提交
```

Host 单测（`tests/host/`，不依赖真机）：

| 文件 | 覆盖 |
|---|---|
| `schema.test.ts` | SPEC §6.1 全字段默认值、volatile 集合、runtime 枚举、R1 白名单 |
| `shell-policy.test.ts` | 白名单/ask、元字符、dumpsys 子集、空/超长命令 |
| `tools.test.ts` | 9 工具名/参数/描述、booting 中间态、错误映射、截图 image/降级、注册与卸载 |
| `config-write.test.ts` | 单键 set、bad-path、冲突重试一次、回读失败、no-settings/no-entry、readPath/deepEqual |
| `http.test.ts` | 鉴权 401/403/503、status/config 快照、POST config 400/409/502、R5、verify 成功/失败、screenshot、404 |
| `service.test.ts` | 单飞、booting 中间态、screenshot 串行、control-only INJECT_TEXT、引用计数+5s 宽限、verify、status、事件、dispose |
| `agent-token.test.ts` | token 路径/生成/0600 落盘、loopback+Origin+常量时间校验、dispose 删除 |
| `shell-policy.test.ts` | 注册级：tools/pre-execute 捕获并断言白名单 next / 非白名单 ask |