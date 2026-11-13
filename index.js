/**
 * 梯子开关 — runtime proxy switcher for DeepSeek Harness.
 *
 * The launcher resolves one proxy policy from the environment before the first plugin loads, so a
 * user who starts DSH with the proxy client off stays direct for the whole process. This plugin
 * reuses the documented `@deepseek-ai/dsh-http-proxy` API — whose install returns a disposer — to
 * swap the process-wide undici dispatcher while the session keeps running.
 *
 * Nothing here touches the operating system's proxy settings, and no request leaves through the
 * proxy unless the user explicitly turns the switch on.
 *
 * Modules are imported through `DSH_INSTALL_DIR` rather than by bare specifier: a locally linked
 * bundle sits outside the install tree, and the profile's own node_modules holds only its own
 * bundles, so Node would not resolve `@deepseek-ai/*` from here.
 * @module @local/dsh-tizi-switch
 */

import { connect } from 'node:net'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const name = 'tizi-switch'
export const inject = ['tools']

/**
 * The `@deepseek-ai/*` directory holding the harness's own packages.
 *
 * `DSH_INSTALL_DIR` names the `@deepseek-ai/dsh` package directory itself, whose sibling packages
 * sit in its grandparent's `node_modules`: `<root>/node_modules/@deepseek-ai/dsh` → `<root>/node_modules`.
 */
function installNodeModules() {
  const installDir = process.env.DSH_INSTALL_DIR
  if (installDir !== undefined && installDir !== '') {
    // <nm>/@deepseek-ai/dsh -> <nm>
    return join(installDir, '..', '..')
  }
  return join(process.execPath, '..', 'resources', 'app.asar', 'dsh', 'node_modules')
}

/**
 * Import one package from the harness installation.
 * @param specifier - the `@deepseek-ai/*` package name.
 * @param entry - that package's module entry, relative to its directory.
 * @returns the imported module namespace.
 */
async function importInstalled(specifier, entry) {
  const dir = join(installNodeModules(), ...specifier.split('/'))
  return await import(pathToFileURL(join(dir, entry)).href)
}

/**
 * Wait until a TCP connection to `host:port` opens or fails, without leaving a socket behind.
 * @param host - proxy host.
 * @param port - proxy HTTP port.
 * @param timeoutMs - budget for the whole probe.
 * @returns whether something accepted the connection.
 */
function probePort(host, port, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    const socket = connect({ host, port })
    const finish = (ok) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.once('timeout', () => finish(false))
  })
}

/**
 * Validate and normalise the row's config. Declared here so a deployment can override the proxy
 * address from `cordis.patch.yml` without editing this file.
 * @param raw - the row's `config` object, possibly empty.
 * @returns the effective settings.
 */
function readConfig(raw) {
  const host = typeof raw?.host === 'string' && raw.host !== '' ? raw.host : '127.0.0.1'
  const port = Number.isInteger(raw?.port) && raw.port > 0 ? raw.port : 7897
  const probeTimeoutMs = Number.isInteger(raw?.probeTimeoutMs) && raw.probeTimeoutMs > 0
    ? raw.probeTimeoutMs
    : 1200
  return { host, port, probeTimeoutMs }
}

/**
 * Register the three proxy tools.
 * @param ctx - registrant context carrying the tool registry.
 * @param rawConfig - deployment's proxy address and probe budget.
 */
export async function apply(ctx, rawConfig) {
  const config = readConfig(rawConfig)
  // Resolved before registering so every tool is in the registry when this promise settles.
  const [{ default: z }, { defineTool }] = await Promise.all([
    importInstalled('@deepseek-ai/schemastery', 'lib/index.mjs'),
    importInstalled('@deepseek-ai/dsh-tools', 'lib/index.js'),
  ])

  // The active installation: `undefined` while the switch is off. The disposer lives here because
  // turning the switch off must run it, and turning it on again installs a fresh policy.
  let active

  // Unloading the plugin must not leave a proxy installed behind a disposed registration. The close
  // is fire-and-forget here because a plugin teardown cannot wait on in-flight request draining.
  ctx.effect(() => () => {
    const current = active
    active = undefined
    if (current !== undefined) void current.dispose().catch(() => {})
  })

  const proxyUrl = `http://${config.host}:${config.port}`

  // One probe shared by every tool, so status and switching never disagree about the port.
  const reachable = () => probePort(config.host, config.port, config.probeTimeoutMs)

  const textOutput = {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  }

  ctx.tools.register(defineTool({
    name: 'proxy_status',
    description:
      'Report whether this Harness instance currently routes its outbound requests through the '
      + 'local proxy, and whether that proxy is reachable right now. Changes nothing.',
    parameters: {},
    output: textOutput,
    async execute() {
      const up = await reachable()
      const state = active === undefined ? '直连（未启用代理）' : `已启用代理 ${active.proxyUrl}`
      const reach = up ? '可连接' : '不可连接'
      return `当前状态：${state}\n代理 ${proxyUrl}：${reach}`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'proxy_on',
    description:
      'Route this Harness instance\'s outbound requests through the local proxy, effective '
      + 'immediately for subsequent requests. Requires the proxy client to be running; fails '
      + 'without changing current routing when its port does not answer.',
    parameters: {},
    output: textOutput,
    async execute() {
      if (active !== undefined) return `代理已经是启用状态：${active.proxyUrl}`
      const up = await reachable()
      if (!up) {
        return `未启用：${config.host}:${config.port} 没有响应，请先启动 Clash Verge。当前仍为直连。`
      }
      const proxyPackage = await importInstalled('@deepseek-ai/dsh-http-proxy', 'lib/index.js')
      const env = {
        get: (key) => {
          if (key === 'http_proxy' || key === 'HTTP_PROXY') return { value: proxyUrl }
          if (key === 'https_proxy' || key === 'HTTPS_PROXY') return { value: proxyUrl }
          return undefined
        },
      }
      const dispose = await proxyPackage.installProxyFromEnvironment(env, () => {})
      active = { proxyUrl, dispose }
      return `已启用代理：${proxyUrl}。从现在起本实例的请求走该代理，无需重启。`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'proxy_off',
    description:
      'Stop routing this Harness instance\'s outbound requests through the proxy and return to '
      + 'direct connections, effective immediately for subsequent requests.',
    parameters: {},
    output: textOutput,
    async execute() {
      const current = active
      if (current === undefined) return '代理本来就是关闭状态，当前为直连。'
      // Clear first: the next request must see direct routing even while the previous agent drains.
      active = undefined
      // The install restores the previous dispatcher and the ambient proxy environment synchronously
      // at the head of its disposer; only the trailing `agent.close()` waits. Awaiting the whole
      // disposer would therefore stall this tool behind in-flight connections while routing had in
      // fact already switched back, so the close is left to settle on its own.
      void current.dispose().catch(() => {})
      return '已关闭代理，恢复直连，无需重启。'
    },
  }))
}
