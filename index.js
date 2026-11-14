/**
 * 梯子开关 — runtime proxy switcher for DeepSeek Harness.
 *
 * The launcher resolves one proxy policy from the environment before the first plugin loads, so a
 * user who starts DSH with the proxy client off stays direct for the whole process. This plugin
 * reuses the documented `@deepseek-ai/dsh-http-proxy` API — whose install returns a disposer — to
 * swap the process-wide undici dispatcher while the session keeps running.
 *
 * The plugin does not assume a port. Users run Clash Verge, v2rayN, sing-box, or a bare shadowsocks
 * client, and each publishes a different port; a fixed default silently fails for everyone else.
 * `detect.js` asks this machine instead: it reads the environment and the Windows system proxy,
 * probes the default ports of the common clients, and finally scans the listening ports. A port is
 * only accepted when it answers the HTTP CONNECT preamble, so a local web server is never mistaken
 * for a proxy.
 *
 * Nothing here touches the operating system's proxy settings, and no request leaves through the
 * proxy unless the user explicitly turns the switch on.
 *
 * Modules are imported through `DSH_INSTALL_DIR` rather than by bare specifier: a locally linked
 * bundle sits outside the install tree, and the profile's own node_modules holds only its own
 * bundles, so Node would not resolve `@deepseek-ai/*` from here.
 * @module dsh-tizi-switch
 */

import { connect } from 'node:net'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { detectProxyEndpoint, describeProbe, probeEndpoint } from './detect.js'

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
 *
 * This is the cheap liveness check used by the health poll. Detection is a heavier question — it
 * has to prove the port is a proxy, not merely that something listens — and lives in `detect.js`.
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

/** The proxy address this plugin installs. */
const DEFAULT_PROXY = { host: '127.0.0.1', port: 7897 }

/**
 * Minimum gap between two detection passes triggered by a cached miss.
 *
 * A miss means the client was not running when the plugin last looked, and the common case is that
 * the user started DSH first and the client second — so the next `proxy_on` must look again, or the
 * plugin stays useless for the rest of the process. Retrying on every call would re-sweep the fifteen
 * known ports on each press, so a short cooldown collapses a burst of attempts into one pass while
 * still letting a genuine retry through.
 *
 * The value is small on purpose. It only has to absorb a double-click or a scripted burst; a user who
 * starts the client and asks again a second later should not be told to try again later. A pass is a
 * handful of loopback connects, so even a few per minute cost nothing worth protecting.
 */
const RETRY_COOLDOWN_MS = 1500

/**
 * Hard ceiling on detection passes per process, as a last-resort guard.
 *
 * A pass reads the environment, the Windows system proxy, and the fifteen known ports: a handful of
 * loopback connects, not a sweep. The cooldown is what keeps the rate sane for a human; this ceiling
 * only stops a pathological caller (a script invoking the tool in a loop) from running it without
 * limit.
 */
const MAX_DETECTION_RUNS = 10

/**
 * Validate and normalise the row's config. Declared here so a deployment can override the proxy
 * address from `cordis.patch.yml` without editing this file.
 *
 * `port` is optional on purpose: leaving it out selects automatic detection, which is the only
 * setting that works across the different proxy clients.
 * @param raw - the row's `config` object, possibly empty.
 * @returns the effective settings.
 */
function readConfig(raw) {
  const host = typeof raw?.host === 'string' && raw.host !== '' ? raw.host : DEFAULT_PROXY.host
  // `0`, a non-integer, or an absent value all mean "detect".
  const port = Number.isInteger(raw?.port) && raw.port > 0 && raw.port <= 65535 ? raw.port : undefined
  const probeTimeoutMs = Number.isInteger(raw?.probeTimeoutMs) && raw.probeTimeoutMs > 0
    ? raw.probeTimeoutMs
    : 400
  // 0 disables the health check, leaving the switch on until the user turns it off.
  const healthCheckMs = Number.isInteger(raw?.healthCheckMs) && raw.healthCheckMs >= 0
    ? raw.healthCheckMs
    : 3000
  // Scanning every listening port is opt-in. It produces the best result but looks like port
  // scanning to antivirus software and endpoint agents, so the plugin does not do it unless the user
  // asks for it. The 15 known default ports cover the clients people actually run.
  const scanListeningPorts = raw?.scanListeningPorts === true
  // How many ports detection reports. The full list belongs in the report the user asks for, not in
  // every switch, so `proxy_status` shows the tail while `proxy_detect` shows everything.
  const reportLimit = Number.isInteger(raw?.reportLimit) && raw.reportLimit > 0 ? raw.reportLimit : 5
  // Escape hatch used by the test suite to isolate detection from the machine's own proxy, so a case
  // that needs "nothing is running" can actually have that. It is not documented for users: the
  // supported way to pin an address is `port`, and the supported way to widen the search is
  // `scanListeningPorts`.
  const detectOptions = raw?.detectOptions !== null && typeof raw?.detectOptions === 'object'
    ? raw.detectOptions
    : undefined
  return { host, port, probeTimeoutMs, healthCheckMs, scanListeningPorts, reportLimit, detectOptions }
}

/**
 * Render detection results as the lines a report is made of.
 * @param detection - the result object from {@link detectProxyEndpoint}.
 * @param limit - how many lines to include; `0` or less includes everything.
 * @returns one line per reported candidate, the usable port first.
 */
function formatDetection(detection, limit) {
  const interesting = detection.results.filter((result) => result.kind !== 'closed')
  const shown = limit > 0 ? interesting.slice(0, limit) : interesting
  const lines = shown.map((result) => {
    const kind = describeProbe(result)
    const where = result.source === undefined ? '' : `，来源：${result.source}`
    return `  · ${result.host}:${result.port} — ${kind}${where}`
  })
  if (limit > 0 && interesting.length > shown.length) {
    lines.push(`  … 另有 ${interesting.length - shown.length} 个端口未显示`)
  }
  return lines
}

/**
 * Register the four proxy tools.
 * @param ctx - registrant context carrying the tool registry.
 * @param rawConfig - deployment's proxy address and probe budget.
 */
export async function apply(ctx, rawConfig) {
  const config = readConfig(rawConfig)
  // Resolved before registering so every tool is in the registry when this promise settles.
  const { defineTool } = await importInstalled('@deepseek-ai/dsh-tools', 'lib/index.js')

  // The active installation: `undefined` while the switch is off. The disposer lives here because
  // turning the switch off must run it, and turning it on again installs a fresh policy.
  let active

  // The health timer that drops the proxy when the client disappears. Registered as an effect so
  // unloading the plugin also stops the timer.
  let healthTimer

  // Where detection last found the proxy, so the report can say whether the address was configured,
  // discovered, or is simply the built-in default.
  let resolvedBy = config.port === undefined ? '未探测（自动检测）' : '配置指定'

  /** The address currently in effect; configured, or discovered by the load-time detection. */
  let effective = config.port === undefined
    ? undefined
    : { host: config.host, port: config.port }

  // Cached answers. `detected` holds the whole discovery result; `detecting` is the run in flight,
  // shared by every caller that arrives while it is going; `configuredVerdict` holds the verdict on a
  // port the user pinned; `lastDetectionAt` paces the re-detection a cached miss may trigger.
  let detected
  let detecting
  let configuredVerdict
  let lastDetectionAt = 0

  // How many times detection has run in this process, exposed in the report so a user can confirm the
  // plugin probes at load rather than on every switch.
  let detectionRuns = 0
  // Whether the one allowed scan pass has been spent. Exposed in the report for the same reason: a
  // user worried about antivirus flags can see it is used at most once.
  let scanUsed = false

  /**
   * Drop the installed proxy and return to direct connections.
   *
   * Clears the timer first: the poll that noticed the failure must not keep running while the
   * switch is off, or it would keep probing a client the user already closed.
   * @returns when the proxy has been released.
   */
  const release = () => {
    if (healthTimer !== undefined) {
      clearInterval(healthTimer)
      healthTimer = undefined
    }
    const current = active
    if (current === undefined) return
    active = undefined
    // The disposer restores the dispatcher synchronously at its head; only the trailing close
    // waits, and a proxy client that just vanished has nothing left to drain.
    void current.dispose().catch(() => {})
  }

  // Unloading the plugin must not leave a proxy installed behind a disposed registration, nor a
  // timer probing a port nobody asked about any more.
  ctx.effect(() => () => { release() })

  const proxyUrlFor = (endpoint) => `http://${endpoint.host}:${endpoint.port}`

  // One probe shared by every tool, so status and switching never disagree about the port.
  const reachable = () => (effective === undefined
    ? Promise.resolve(false)
    : probePort(effective.host, effective.port, config.probeTimeoutMs))

  /**
   * Ask this machine where its proxy is.
   *
   * Detection runs once at load and its answer is cached. Re-running it on every `proxy_on` would be
   * both wasteful and alarming: enumerating every listening port repeatedly in one process is exactly
   * the pattern endpoint-tracking software treats as a port scan, and this plugin has no business
   * looking like that.
   *
   * The one case worth retrying is a load-time miss. DSH is often started before the proxy client, so
   * a cached failure would leave the plugin useless for the rest of the process even after the client
   * comes up. A retry therefore re-reads the environment, the system proxy, and the known ports — but
   * only once per process, and only after a failure, so the scan pass can never repeat.
   *
   * A configured port is still verified, because pointing the dispatcher at a dead port turns every
   * outbound request into `ECONNREFUSED` — the failure this plugin exists to prevent.
   * @returns the endpoint to use, the verdict on a configured port, and the detection result.
   */
  const resolveEndpoint = async () => {
    if (config.port !== undefined) {
      if (configuredVerdict === undefined) {
        configuredVerdict = await probeEndpoint(config.host, config.port, config.probeTimeoutMs)
      }
      return {
        endpoint: configuredVerdict.kind === 'http-proxy'
          ? { host: config.host, port: config.port }
          : undefined,
        configuredProbe: configuredVerdict,
        detection: undefined,
      }
    }
    // A cached success stands while its port still answers. A cached address whose port has gone quiet
    // is re-detected, because the user may have switched clients and the new one listens elsewhere;
    // without this the plugin would refuse forever while a working proxy was running. A cached miss is
    // re-detected too: DSH is usually started before the client, so refusing on the strength of a
    // load-time miss would leave the plugin useless for the rest of the process.
    //
    // Rate is governed by a cooldown rather than a one-shot allowance. A one-shot allowance sounds
    // stricter, but it is spent by the first failed attempt, so a user who tries once before starting
    // the client could never succeed afterwards — a bug this shipped with. The cooldown instead
    // collapses a burst of presses into one pass and still allows a real retry seconds later.
    //
    // No retry scans. The scan pass is the behaviour that looks like port scanning, so it runs at
    // most once per process, on the very first detection and only if the user enabled it.
    //
    // An in-flight run is shared rather than started again. `apply` kicks off detection in the
    // background so a mount is not delayed by it, which means the first tool call can arrive while
    // that run is still going; without this check it would start a second sweep immediately.
    if (detecting !== undefined) {
      detected = await detecting
      return { endpoint: detected.endpoint, configuredProbe: undefined, detection: detected }
    }
    // Is the cached answer still true? A cached endpoint that no longer answers must not be installed.
    const cachedStale = detected !== undefined && detected.endpoint !== undefined
      && !await probePort(detected.endpoint.host, detected.endpoint.port, config.probeTimeoutMs)
    const budgetLeft = detectionRuns < MAX_DETECTION_RUNS
    const cooled = Date.now() - lastDetectionAt >= RETRY_COOLDOWN_MS
    const wantsDetect = detected === undefined || cachedStale || detected.endpoint === undefined
    const mayRetry = budgetLeft && cooled && wantsDetect
    if (detected !== undefined && !mayRetry) {
      return { endpoint: detected.endpoint, configuredProbe: undefined, detection: detected }
    }
    detectionRuns += 1
    lastDetectionAt = Date.now()
    // The scan pass belongs to the first detection only. It is the expensive, alarming part, and the
    // point of caching is that the plugin never looks like a port scanner. Later runs — including the
    // re-detection after a client switch — read the environment, the system proxy, and the known
    // ports, which is enough to follow a client to any of its documented ports.
    const allowScan = config.scanListeningPorts && detectionRuns === 1
    if (allowScan) scanUsed = true
    detecting = detectProxyEndpoint({
      host: config.host,
      probeTimeoutMs: config.probeTimeoutMs,
      scanListeningPorts: allowScan,
      ...config.detectOptions,
    })
    try {
      detected = await detecting
    } finally {
      detecting = undefined
    }
    return { endpoint: detected.endpoint, configuredProbe: undefined, detection: detected }
  }

  /**
   * Watch the proxy port while the switch is on.
   *
   * The client can be closed at any moment, and once installed the policy points every request at
   * its port: a dead port fails each request with ECONNREFUSED in milliseconds. Polling is cheap
   * here because a loopback connect either answers or refuses almost immediately, and the poll is
   * the only way to notice a departure the plugin never controls.
   */
  const startHealthCheck = () => {
    if (healthTimer !== undefined) return
    healthTimer = setInterval(() => {
      if (active === undefined) return
      void reachable().then((up) => {
        // A probe that started while the switch was on must not release a newer installation.
        if (!up && active !== undefined) release()
      }).catch(() => {})
    }, config.healthCheckMs)
    // Never hold the process open just to poll a port.
    healthTimer.unref?.()
  }

  const textOutput = {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  }

  ctx.tools.register(defineTool({
    name: 'proxy_status',
    description:
      'Report whether this Harness instance currently routes its outbound requests through the '
      + 'local proxy, which port it uses, and whether that proxy is reachable right now. '
      + 'Changes nothing.',
    parameters: {},
    output: textOutput,
    async execute() {
      const state = active === undefined ? '直连（未启用代理）' : `已启用代理 ${active.proxyUrl}`
      const address = effective === undefined
        ? '尚未探测（首次开启时自动探测）'
        : `${effective.host}:${effective.port}（${resolvedBy}）`
      const reach = effective === undefined ? '尚未探测' : (await reachable() ? '可连接' : '不可连接')
      const watch = config.healthCheckMs > 0
        ? `每 ${Math.round(config.healthCheckMs / 100) / 10} 秒探测一次已启用的端口，客户端退出后自动回直连`
        : '自动检测已关闭'
      const detection = config.port === undefined
        ? `自动探测（本次已探测 ${detectionRuns} 次；仅在加载时、端口失效时或客户端稍后启动时探测，`
          + `两次探测至少间隔 ${Math.round(RETRY_COOLDOWN_MS / 1000)} 秒，`
          + `${scanUsed ? '已用过一次全端口扫描' : '不做全端口扫描'}）`
        : '已指定端口，不自动探测（调 proxy_detect 可查看本机实际可用端口）'
      return `当前状态：${state}\n代理地址：${address}\n端口连通性：${reach}\n端口来源：${detection}\n自动检测：${watch}`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'proxy_detect',
    description:
      'Look for a local proxy client on this machine without changing anything: check the proxy '
      + 'environment, the Windows system proxy, the default ports of the common clients (Clash, '
      + 'v2rayN, sing-box, Shadowsocks), and finally every listening port. Reports which port is a '
      + 'usable HTTP proxy and why the others were rejected.',
    parameters: {},
    output: textOutput,
    async execute() {
      // Reuses the load-time result through the same path `proxy_on` uses. Probing separately here
      // would make the report disagree with what was actually installed, and would run the scan pass
      // a second time in one process.
      const { detection } = await resolveEndpoint()
      if (detection === undefined) {
        // A pinned port: the discovery result does not exist, so run one scoped to the report.
        const probe = configuredVerdict ?? await probeEndpoint(config.host, config.port, config.probeTimeoutMs)
        return `当前配置指定了端口 ${config.host}:${config.port}：${describeProbe(probe)}\n`
          + '自动探测没有启用。想改为自动探测，请从 profile 的 cordis.patch.yml 里删掉 port 一行。'
      }
      const lines = [`探测完成，用时 ${detection.durationMs} ms${detection.scanned ? '（含全端口扫描）' : ''}`]
      if (detection.endpoint !== undefined) {
        const source = detection.endpoint.source ?? '未知来源'
        lines.push(`可用 HTTP 代理：${detection.endpoint.host}:${detection.endpoint.port}（来源：${source}）`)
        if (config.port !== undefined && config.port !== detection.endpoint.port) {
          lines.push(`注意：配置里固定的是 ${config.host}:${config.port}，与探测结果不同；`
            + '想改用探测结果，请从 profile 的 cordis.patch.yml 里删掉 port 一行。')
        }
      } else {
        lines.push('没有找到可用的 HTTP 代理端口。')
      }
      const detail = formatDetection(detection, 0)
      if (detail.length > 0) lines.push('探测到的端口：', ...detail)
      const socks = detection.results.find((result) => result.kind === 'socks5' || result.kind === 'socks4')
      if (socks !== undefined && detection.endpoint === undefined) {
        lines.push(`提示：${socks.host}:${socks.port} 是 SOCKS 端口，DSH 只支持 HTTP 代理；`
          + '请在客户端里再开一个 HTTP / mixed 入站。')
      }
      if (!detection.scanned && config.scanListeningPorts !== true) {
        lines.push('提示：当前不扫描全部监听端口。若你的客户端改过端口，可在 profile 的 '
          + 'cordis.patch.yml 里设 `scanListeningPorts: true` 后重启。')
      }
      return lines.join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'proxy_on',
    description:
      'Route this Harness instance\'s outbound requests through the local proxy, effective '
      + 'immediately for subsequent requests. The proxy port is detected automatically when the '
      + 'plugin was not configured with one. Fails without changing current routing when no usable '
      + 'proxy answers.',
    parameters: {},
    output: textOutput,
    async execute() {
      if (active !== undefined) return `代理已经是启用状态：${active.proxyUrl}`
      const { endpoint, configuredProbe, detection } = await resolveEndpoint()
      if (endpoint === undefined) {
        const lines = configuredProbe === undefined
          ? ['未启用：没有找到可用的本地 HTTP 代理端口，当前仍为直连。']
          : [`未启用：配置里指定的 ${config.host}:${config.port} ${describeProbe(configuredProbe)}，当前仍为直连。`]
        if (detection !== undefined) {
          const detail = formatDetection(detection, config.reportLimit)
          // An empty result list means nothing was even listening, which is the common case when the
          // client is not running. Printing a "results:" header with nothing under it says less than
          // one sentence stating that finding.
          if (detail.length > 0) lines.push('探测详情：', ...detail)
          else lines.push('探测范围：环境变量、Windows 系统代理、15 个常见客户端端口，均无响应。')
          const socks = detection.results.find((result) => result.kind === 'socks5' || result.kind === 'socks4')
          if (socks !== undefined) {
            lines.push(`${socks.host}:${socks.port} 是 SOCKS 端口，DSH 只支持 HTTP 代理；`
              + '请在代理客户端里启用 HTTP 或 mixed 入站。')
          }
        }
        if (configuredProbe !== undefined) {
          lines.push('想改端口：编辑 profile 的 cordis.patch.yml，把 port 改成实际端口；'
            + '删掉 port 一行则改为自动探测。调 proxy_detect 可查看本机实际可用的端口。')
        } else {
          lines.push('请先启动代理客户端，或调 proxy_detect 查看本机实际监听的端口。')
        }
        return lines.join('\n')
      }
      effective = endpoint
      resolvedBy = config.port !== undefined
        ? '配置指定'
        : `自动探测（${endpoint.source ?? '探测'}）`
      // The cached address is a hint, not a promise: the client may have been closed since load. A
      // dead port fails every request with ECONNREFUSED, which is the failure this plugin exists to
      // prevent, so the address is re-checked with one loopback connect before it is installed. This
      // is not a detection pass — it probes exactly one known port and never enumerates anything.
      if (!await reachable()) {
        return `未启用：探测到的 ${endpoint.host}:${endpoint.port} 现在没有响应，代理客户端可能已退出。`
          + '当前仍为直连。请先启动代理客户端再开启，或调 proxy_detect 查看当前可用端口。'
      }
      const proxyUrl = proxyUrlFor(endpoint)
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
      startHealthCheck()
      const origin = config.port !== undefined ? '配置指定' : `自动探测，来源：${endpoint.source ?? '探测'}`
      return `已启用代理：${proxyUrl}（${origin}）。从现在起本实例的请求走该代理，无需重启。`
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
      if (active === undefined) return '代理本来就是关闭状态，当前为直连。'
      release()
      return '已关闭代理，恢复直连，无需重启。'
    },
  }))

  // Discover the endpoint once, now that the tools exist, so the first `proxy_on` is a switch rather
  // than a switch plus a discovery. A failure here must not fail the plugin load: the user may simply
  // have started DSH before their proxy client, and `proxy_on` reports that case with a better message
  // than a mount error would, so the error is swallowed and left for the tools to surface.
  void resolveEndpoint().then(({ endpoint, detection }) => {
    if (endpoint === undefined) return
    effective = endpoint
    resolvedBy = config.port !== undefined ? '配置指定' : `自动探测（${endpoint.source ?? '探测'}）`
    void detection
  }).catch(() => {})
}
