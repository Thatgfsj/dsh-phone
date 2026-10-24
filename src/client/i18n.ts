/**
 * Component copy for the dsh-phone Web client.
 *
 * The Host reads `locale/{zh,en}.json` (`meta.title` / `meta.description`);
 * this dictionary only covers the strings rendered by our own components.
 * Keys are flat and templated with `{name}` placeholders; `translate`
 * falls back to English and then to the key itself so a missing entry can
 * never blank the UI.
 */

/** Locale namespace registered through `ctx.locale` (one per feature). */
export const NS = 'dsh-phone'

export type Dict = Record<string, string>

export const zh: Dict = {
  'panel.title': '手机',
  'panel.status.idle': '未连接',
  'panel.status.connecting': '连接中…',
  'panel.status.open': '握手中…',
  'panel.status.ready': '已连接',
  'panel.status.reconnecting': '重连中…',
  'panel.status.closed': '已断开',
  'panel.status.hidden': '面板不可见，已停止拉流',
  'panel.meta': '{width}×{height} · {codec} · {fps}fps',
  'panel.decoder.webcodecs': '硬解 (WebCodecs)',
  'panel.decoder.tinyh264': '软解 (TinyH264)',
  'panel.decoder.pending': '解码器准备中…',
  'panel.reconnect': '重新连接',
  'panel.settingsHint': '在「设置 → 手机」里修改一句话或重置解析。',
  'panel.error.auth': '鉴权失败：请在 DSH Web 页面内打开本面板。',
  'panel.error.noWeb': '当前 DSH 没有 Web 服务，视频流不可用。',
  'panel.error.stream': '视频流启动失败：{message}',
  'panel.error.decoder': '解码器初始化失败：{message}',
  'panel.error.unsupported': '此浏览器不支持 WebCodecs，已回退到软件解码。',
  'panel.error.fatal': '无法显示画面（解码器不可用）。请刷新页面重试。',
  'panel.keys.home': '主屏',
  'panel.keys.back': '返回',
  'panel.keys.recents': '最近',
  'panel.keys.enter': '确认',
  'panel.keys.del': '删除',
  'settings.section': '手机',
  'settings.title': 'dsh 的手机',
  'settings.description': '用一句话告诉 Agent 你的模拟器在哪里；解析由 Agent 完成，重置权属于你。',
  'settings.hint.label': '一句话',
  'settings.hint.placeholder': '例如：用的雷电模拟器，装在默认位置',
  'settings.hint.save': '保存一句话',
  'settings.hint.saving': '保存中…',
  'settings.hint.saved': '已保存',
  'settings.hint.conflict': '配置已被更新，已刷新后重试一次',
  'settings.hint.failed': '保存失败：{message}',
  'settings.state.title': '解析状态',
  'settings.state.resolved': '已解析',
  'settings.state.unresolved': '待解析',
  'settings.state.endpoint': '端点',
  'settings.state.endpointNone': '未写入',
  'settings.state.runtime': '运行时',
  'settings.state.runState': '运行状态',
  'settings.state.lastError': '最近错误',
  'settings.reset': '重置解析',
  'settings.reset.confirm': '确认重置？Agent 下次运行时会重新解析一句话。',
  'settings.reset.done': '已重置解析状态',
  'settings.reset.failed': '重置失败：{message}',
  'settings.openPanel': '打开手机面板',
  'settings.refresh': '刷新',
  'settings.loading': '读取配置中…',
  'settings.loadFailed': '读取配置失败：{message}',
  'settings.unavailable': 'Host 侧配置接口不可用（插件未启用或未运行）。',
}

export const en: Dict = {
  'panel.title': 'Phone',
  'panel.status.idle': 'Disconnected',
  'panel.status.connecting': 'Connecting…',
  'panel.status.open': 'Handshaking…',
  'panel.status.ready': 'Connected',
  'panel.status.reconnecting': 'Reconnecting…',
  'panel.status.closed': 'Disconnected',
  'panel.status.hidden': 'Panel hidden — stream stopped',
  'panel.meta': '{width}×{height} · {codec} · {fps}fps',
  'panel.decoder.webcodecs': 'Hardware (WebCodecs)',
  'panel.decoder.tinyh264': 'Software (TinyH264)',
  'panel.decoder.pending': 'Preparing decoder…',
  'panel.reconnect': 'Reconnect',
  'panel.settingsHint': 'Edit the one-liner or reset parsing in Settings → Phone.',
  'panel.error.auth': 'Not authorized: open this panel inside the DSH Web page.',
  'panel.error.noWeb': 'This DSH instance has no Web carrier; video is unavailable.',
  'panel.error.stream': 'Stream failed: {message}',
  'panel.error.decoder': 'Decoder initialization failed: {message}',
  'panel.error.unsupported': 'This browser lacks WebCodecs; using software decoding.',
  'panel.error.fatal': 'Cannot render video (no usable decoder). Reload the page.',
  'panel.keys.home': 'Home',
  'panel.keys.back': 'Back',
  'panel.keys.recents': 'Recents',
  'panel.keys.enter': 'Enter',
  'panel.keys.del': 'Del',
  'settings.section': 'Phone',
  'settings.title': "Fat Fish's Phone",
  'settings.description': 'Tell the Agent where your emulator is in one sentence; it resolves the endpoint and only you may reset it.',
  'settings.hint.label': 'One-liner',
  'settings.hint.placeholder': 'e.g. LDPlayer, installed in the default location',
  'settings.hint.save': 'Save',
  'settings.hint.saving': 'Saving…',
  'settings.hint.saved': 'Saved',
  'settings.hint.conflict': 'Configuration changed; refreshed and retried once',
  'settings.hint.failed': 'Save failed: {message}',
  'settings.state.title': 'Resolution',
  'settings.state.resolved': 'Resolved',
  'settings.state.unresolved': 'Pending',
  'settings.state.endpoint': 'Endpoint',
  'settings.state.endpointNone': 'not written',
  'settings.state.runtime': 'Runtime',
  'settings.state.runState': 'Run state',
  'settings.state.lastError': 'Last error',
  'settings.reset': 'Reset resolution',
  'settings.reset.confirm': 'Reset? The Agent will re-resolve the one-liner on its next run.',
  'settings.reset.done': 'Resolution state reset',
  'settings.reset.failed': 'Reset failed: {message}',
  'settings.openPanel': 'Open phone panel',
  'settings.refresh': 'Refresh',
  'settings.loading': 'Loading configuration…',
  'settings.loadFailed': 'Failed to load configuration: {message}',
  'settings.unavailable': 'The Host configuration API is unavailable (plugin disabled or not running).',
}

/** Choose a dictionary for one active locale id, defaulting to English. */
export function dictionaryFor(locale: string, catalogs: { zh: Dict; en: Dict } = { zh, en }): Dict {
  return locale.toLowerCase().startsWith('zh') ? catalogs.zh : catalogs.en
}

/** Substitute `{name}` placeholders; unknown placeholders stay literal. */
export function format(template: string, vars?: Readonly<Record<string, string | number>>): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
  )
}

/** Translate one key with English fallback, then the key itself. */
export function translate(
  key: string,
  vars?: Readonly<Record<string, string | number>>,
  locale = 'en',
  catalogs: { zh: Dict; en: Dict } = { zh, en },
): string {
  const primary = dictionaryFor(locale, catalogs)
  const template = primary[key] ?? catalogs.en[key] ?? key
  return format(template, vars)
}
