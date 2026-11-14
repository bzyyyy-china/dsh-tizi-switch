/**
 * Endpoint detection for the 梯子开关 plugin.
 *
 * A fixed port is the one assumption this plugin cannot keep. Clash Verge listens on 7897, v2rayN
 * puts its HTTP inbound on 10809 while its SOCKS inbound takes 10808, sing-box's mixed inbound sits
 * on 2080, and a plain Shadowsocks client on 1080 — shipping any one of those as the default silently
 * breaks the switch for everyone using another. Detection asks this machine instead of assuming.
 *
 * An open TCP port is not evidence of a proxy. The DSH Web UI, a dev server, and every other local
 * service accept a connection too, and pointing the process-wide dispatcher at one of them turns each
 * outbound request into a failure. A candidate is therefore accepted only when it answers the HTTP
 * CONNECT preamble — the exchange every HTTP proxy implements and nothing else routinely does.
 *
 * The probe never opens a real tunnel: it asks to CONNECT to `127.0.0.1:9`, a discard port with no
 * listener, so detection stops at the proxy client and sends nothing off this machine even when that
 * client currently holds a live outbound node.
 *
 * A SOCKS port is reported rather than used. `@deepseek-ai/dsh-http-proxy` accepts only `http:` and
 * `https:` proxy URLs and skips anything else, so a v2rayN user who lands on the 10808 inbound has to
 * be told to enable the HTTP one — silently installing it would leave every request direct while the
 * switch claimed to be on.
 * @module dsh-tizi-switch/detect
 */

import { execFile } from 'node:child_process'
import { connect } from 'node:net'

/**
 * Probe budget for one port during the first pass. A loopback connect answers or refuses almost
 * immediately; only a listener that accepts and then stays silent consumes the whole budget.
 */
const DEFAULT_PROBE_TIMEOUT_MS = 400

/**
 * Probe budget while scanning every listening port. Tighter than the first pass because that pass
 * runs over a set whose size this module does not choose.
 */
const DEFAULT_SCAN_TIMEOUT_MS = 300

/** How many ports are probed at once. */
const DEFAULT_CONCURRENCY = 8

/** Cap on the scan pass, so an unusual machine cannot stretch one switch into tens of seconds. */
const MAX_SCAN_PORTS = 128

/**
 * Listening ports below this are skipped in the scan pass. Proxy clients do not take a privileged
 * port, while the operating system fills the low range with services that would only spend budget.
 */
const PRIVILEGED_PORT_CEILING = 1024

/**
 * The CONNECT target. Port 9 is the discard port: nothing listens on it, so a proxy that reports
 * success is reporting on its own handling of the request rather than on a reachable upstream.
 */
const PROBE_TARGET = '127.0.0.1:9'

/**
 * Default endpoints of the proxy clients in common use, most widespread first.
 *
 * The order matters twice over: it decides which client a successful port is attributed to in the
 * report, and it puts the port a Chinese Windows user is most likely to have in the first few probes.
 */
export const KNOWN_ENDPOINTS = Object.freeze([
  Object.freeze({ port: 7897, client: 'Clash Verge / Clash for Windows（mixed-port）' }),
  Object.freeze({ port: 10809, client: 'v2rayN / v2rayA（HTTP 入站）' }),
  Object.freeze({ port: 7890, client: 'Clash / mihomo（http-port）' }),
  Object.freeze({ port: 2080, client: 'sing-box / NekoRay（mixed）' }),
  Object.freeze({ port: 1080, client: 'Shadowsocks / 通用 SOCKS' }),
  Object.freeze({ port: 10808, client: 'v2rayN（SOCKS 入站）' }),
  Object.freeze({ port: 2081, client: 'sing-box（另一个入站）' }),
  Object.freeze({ port: 7891, client: 'Clash（socks-port）' }),
  Object.freeze({ port: 20170, client: 'v2rayA（HTTP 入站）' }),
  Object.freeze({ port: 20171, client: 'v2rayA（SOCKS 入站）' }),
  Object.freeze({ port: 12334, client: 'Hiddify（mixed）' }),
  Object.freeze({ port: 8889, client: 'Qv2ray（HTTP 入站）' }),
  Object.freeze({ port: 8118, client: 'Privoxy' }),
  Object.freeze({ port: 6152, client: 'Surge' }),
  Object.freeze({ port: 1087, client: 'SSR / ShadowsocksR' }),
])

/**
 * How a candidate port answered.
 *
 * `http-proxy` is the only verdict this plugin can install. The rest exist so the report can say why
 * a port was rejected instead of leaving the user with "not found".
 */
const KIND = Object.freeze({
  HTTP_PROXY: 'http-proxy',
  HTTP_AUTH: 'http-auth',
  SOCKS5: 'socks5',
  SOCKS4: 'socks4',
  NOT_PROXY: 'not-proxy',
  CLOSED: 'closed',
  UNREACHABLE: 'unreachable',
})

/** Ranking so the display lists usable ports first, then the near misses that explain a failure. */
const KIND_RANK = Object.freeze({
  [KIND.HTTP_PROXY]: 0,
  [KIND.HTTP_AUTH]: 1,
  [KIND.SOCKS5]: 2,
  [KIND.SOCKS4]: 3,
  [KIND.NOT_PROXY]: 4,
  [KIND.CLOSED]: 5,
  [KIND.UNREACHABLE]: 6,
})

/**
 * Ranking of the evidence that named a candidate. A port the user configured somewhere wins over one
 * this module guessed from a list, so an explicit source is preferred when several ports answer.
 */
const ORIGIN_RANK = Object.freeze({ env: 0, system: 1, known: 2, scan: 3 })

/**
 * Describe one probe verdict for the model-facing report.
 * @param result - a result from {@link probeEndpoint}.
 * @returns a short Chinese phrase.
 */
export function describeProbe(result) {
  switch (result.kind) {
    case KIND.HTTP_PROXY: {
      const note = result.status === undefined ? '' : `，返回 ${result.status}`
      return `可用（HTTP 代理${note}）`
    }
    case KIND.HTTP_AUTH:
      return 'HTTP 代理，但要求用户名口令（本插件不支持带认证的代理）'
    case KIND.SOCKS5:
      return 'SOCKS5 端口（DSH 只支持 HTTP 代理，需要在客户端再开一个 HTTP 入站）'
    case KIND.SOCKS4:
      return 'SOCKS4 端口（DSH 只支持 HTTP 代理，需要在客户端再开一个 HTTP 入站）'
    case KIND.NOT_PROXY:
      return '端口有服务，但它不是代理'
    case KIND.CLOSED:
      return '没有监听（客户端没运行？）'
    default:
      return '无法连接'
  }
}

/**
 * Run `worker` over `items` with at most `limit` in flight.
 *
 * Written out rather than pulled from a package: this plugin ships with no dependencies, and the
 * whole point of the scan pass is to finish quickly instead of starting one probe per listening port.
 * @param items - the work items.
 * @param limit - maximum concurrent workers.
 * @param worker - async function for one item.
 * @returns one result per item, in the input order.
 */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const current = next
      next += 1
      results[current] = await worker(items[current], current)
    }
  })
  await Promise.all(runners)
  return results
}

/**
 * Speak HTTP CONNECT at one port and read the status line.
 *
 * The status code is only part of the answer. A proxy that answers `200` established the tunnel this
 * probe asked for; a `502`/`503`/`504` still proves the port tried to forward the request, which no
 * ordinary web server does for a CONNECT it does not implement; a `407` proves it is a proxy that
 * wants credentials. Anything else — `400`, `405`, `501`, a redirect, a non-HTTP reply, silence —
 * means the port is not an HTTP proxy this plugin can use.
 * @param host - candidate host.
 * @param port - candidate port.
 * @param timeoutMs - budget for connect plus reply.
 * @returns the verdict plus the status code when one arrived.
 */
function probeHttp(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    let buffer = ''
    let settled = false
    let connected = false
    const socket = connect({ host, port })

    const finish = (kind, status) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve({ kind, status, ms: Date.now() - startedAt })
    }

    socket.setTimeout(timeoutMs)
    socket.once('connect', () => {
      connected = true
      socket.write(`CONNECT ${PROBE_TARGET} HTTP/1.1\r\nHost: ${PROBE_TARGET}\r\nProxy-Connection: keep-alive\r\n\r\n`)
    })
    // A server that accepts and then hangs up without replying is the common case for a plain HTTP
    // service — the DSH Web UI itself does this. Without this listener the probe would wait for a
    // timeout that a closed socket never produces, leaving the caller's promise unsettled.
    socket.once('close', () => {
      if (buffer === '') finish(connected ? KIND.NOT_PROXY : KIND.CLOSED)
    })

    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1')
      const lineEnd = buffer.indexOf('\r\n')
      if (lineEnd === -1) {
        // Reject an early answer that cannot be the start of a status line, instead of waiting out the
        // timeout against a port that already showed it is not speaking HTTP.
        const prefix = buffer.slice(0, 5)
        if (prefix.length > 0 && !'HTTP/'.startsWith(prefix)) finish(KIND.NOT_PROXY)
        return
      }
      const match = /^HTTP\/1\.[01] (\d{3})/.exec(buffer.slice(0, lineEnd))
      if (match === null) {
        finish(KIND.NOT_PROXY)
        return
      }
      const status = Number(match[1])
      if (status >= 200 && status < 300) finish(KIND.HTTP_PROXY, status)
      else if (status === 407) finish(KIND.HTTP_AUTH, status)
      else if (status === 502 || status === 503 || status === 504) finish(KIND.HTTP_PROXY, status)
      else finish(KIND.NOT_PROXY, status)
    })

    socket.once('timeout', () => finish(KIND.NOT_PROXY))
    socket.once('error', (error) => {
      if (error?.code === 'ECONNREFUSED') finish(KIND.CLOSED)
      // Anything else after a successful connect still means a listener was there and answered
      // wrongly — a reset is how an origin server rejects a CONNECT it does not implement. Reporting
      // it as unreachable would say "nothing is running" about a port that is very much running.
      else finish(connected ? KIND.NOT_PROXY : KIND.UNREACHABLE)
    })
  })
}

/**
 * Speak the SOCKS5 greeting at one port.
 *
 * Detection needs this only to explain a failure: a v2rayN user whose 10808 inbound answers here has
 * a working proxy client and a port this plugin cannot install, which is a very different message
 * from "nothing is running".
 * @param host - candidate host.
 * @param port - candidate port.
 * @param timeoutMs - budget for connect plus reply.
 * @returns whether the port answers as SOCKS5.
 */
function probeSocks5(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    let settled = false
    const socket = connect({ host, port })
    const finish = (ok) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve({ ok, ms: Date.now() - startedAt })
    }
    socket.setTimeout(timeoutMs)
    // Version 5, one method offered (no authentication).
    socket.once('connect', () => socket.write(Buffer.from([0x05, 0x01, 0x00])))
    socket.on('data', (chunk) => {
      // A method-selection reply is exactly two bytes starting with the version. An HTTP server
      // answering `400 Bad Request` starts with `H`, so the first byte alone is decisive.
      finish(chunk.length >= 2 && chunk[0] === 0x05)
    })
    socket.once('timeout', () => finish(false))
    socket.once('close', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

/**
 * Speak the SOCKS4 CONNECT request at one port, for clients that never learned version 5.
 * @param host - candidate host.
 * @param port - candidate port.
 * @param timeoutMs - budget for connect plus reply.
 * @returns whether the port answers as SOCKS4.
 */
function probeSocks4(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    let settled = false
    const socket = connect({ host, port })
    const finish = (ok) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve({ ok, ms: Date.now() - startedAt })
    }
    socket.setTimeout(timeoutMs)
    // Version 4, CONNECT, port 9, 127.0.0.1, empty user id — the same discard target as the HTTP probe.
    socket.once('connect', () => socket.write(Buffer.from([0x04, 0x01, 0x00, 0x09, 127, 0, 0, 1, 0x00])))
    socket.on('data', (chunk) => {
      // The reply is version 0 followed by the result code; 0x5a means "request granted".
      finish(chunk.length >= 2 && chunk[0] === 0x00 && chunk[1] === 0x5a)
    })
    socket.once('timeout', () => finish(false))
    socket.once('close', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

/**
 * Classify one port.
 *
 * HTTP is asked first and, when the answer is already decisive, SOCKS is not asked at all: a mixed
 * inbound (Clash Verge's default) answers both, and the protocol this plugin can actually install is
 * the one worth naming.
 * @param host - candidate host.
 * @param port - candidate port.
 * @param timeoutMs - budget for the whole classification.
 * @returns the verdict, with the HTTP status when one was returned.
 */
export async function probeEndpoint(host, port, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS) {
  const http = await probeHttp(host, port, timeoutMs)
  if (http.kind === KIND.HTTP_PROXY || http.kind === KIND.HTTP_AUTH) return http
  // A refused connection has nothing listening, so the SOCKS greeting would only repeat the refusal.
  if (http.kind === KIND.CLOSED || http.kind === KIND.UNREACHABLE) return http
  const socks5 = await probeSocks5(host, port, timeoutMs)
  if (socks5.ok) return { kind: KIND.SOCKS5, ms: http.ms + socks5.ms }
  const socks4 = await probeSocks4(host, port, timeoutMs)
  if (socks4.ok) return { kind: KIND.SOCKS4, ms: http.ms + socks4.ms }
  return http
}

/**
 * Run one command and return its output, or `undefined` when it could not be run.
 * @param command - executable name.
 * @param args - argument list.
 * @param encoding - how to decode stdout; `latin1` keeps ASCII intact when the console codepage is not UTF-8.
 * @returns stdout, or `undefined` on failure with no output.
 */
function runCommand(command, args, encoding = 'utf8') {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: 4000, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'buffer' },
      (error, stdout) => {
        const text = stdout === undefined ? '' : Buffer.from(stdout).toString(encoding)
        if (text !== '') resolve(text)
        else resolve(error === null ? '' : undefined)
      },
    )
  })
}

/**
 * Parse one proxy value into a host and port.
 *
 * A scheme is optional because the Windows registry and hand-written `HTTP_PROXY` values both appear
 * without one. A SOCKS value is still parsed out: it becomes a candidate whose probe reports it as
 * SOCKS, which is the message a v2rayN user needs.
 * @param value - `host:port`, `http://host:port`, optionally with credentials.
 * @returns the parsed endpoint, or `undefined` when it names none.
 */
function parseProxyEndpoint(value) {
  const text = String(value ?? '').trim()
  if (text === '') return undefined
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`
  let url
  try {
    url = new URL(withScheme)
  } catch {
    return undefined
  }
  if (url.hostname === '') return undefined
  const explicit = url.port !== '' ? Number(url.port) : undefined
  const fallback = url.protocol === 'https:' ? 443 : url.protocol === 'http:' ? 80 : undefined
  const port = explicit ?? fallback
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined
  return { host: url.hostname.replace(/^\[|\]$/g, ''), port }
}

/**
 * Read the Windows system proxy from the registry.
 *
 * Worth asking even though DSH itself never reads the operating system's proxy: the value records the
 * address the user's proxy client last published, which is exactly the port this plugin needs. Read
 * through `reg` rather than a registry binding so the plugin keeps working with no native dependency.
 * @returns the endpoint, or `undefined` when no system proxy is enabled.
 */
async function readSystemProxy() {
  if (process.platform !== 'win32') return undefined
  const output = await runCommand(
    'reg',
    ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
    'latin1',
  )
  if (output === undefined) return undefined
  const values = {}
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s+(\S+)\s+REG_\w+\s+(.*)$/.exec(line)
    if (match !== null) values[match[1]] = match[2].trim()
  }
  // `0x0` and `0` both mean disabled; an absent value means the key was never set.
  const enabled = Number(values.ProxyEnable) !== 0 && values.ProxyEnable !== undefined
  if (!enabled) return undefined
  const raw = values.ProxyServer ?? ''
  if (raw === '') return undefined
  // The modern form is per-scheme, e.g. `http=127.0.0.1:7897;https=127.0.0.1:7897;socks=…`.
  if (!raw.includes('=')) return parseProxyEndpoint(raw)
  const perScheme = new Map()
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    perScheme.set(part.slice(0, eq).trim().toLowerCase(), part.slice(eq + 1).trim())
  }
  const httpish = perScheme.get('http') ?? perScheme.get('https')
  return httpish === undefined ? undefined : parseProxyEndpoint(httpish)
}

/**
 * Enumerate the ports this machine is listening on.
 *
 * The last resort of detection, needed when a user moved the client to a port no list knows. Only
 * loopback and wildcard listeners are considered: a proxy on another interface would be reachable,
 * but every entry here is probed from this machine, and the wildcard list is where a client that binds
 * `0.0.0.0` appears.
 * @returns listening ports, ascending, without duplicates.
 */
async function listListeningPorts() {
  const ports = new Set()
  if (process.platform === 'win32') {
    const output = await runCommand('netstat', ['-ano', '-p', 'TCP'])
    if (output === undefined) return []
    for (const line of output.split(/\r?\n/)) {
      const match = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+(?:LISTENING|侦听)/i.exec(line)
      if (match === null) continue
      const port = Number(match[1])
      if (port >= PRIVILEGED_PORT_CEILING) ports.add(port)
    }
    return [...ports].sort((a, b) => a - b)
  }
  // `ss` is the Linux default; `netstat` covers the systems that ship only that.
  const output = await runCommand('ss', ['-ltn']) ?? await runCommand('netstat', ['-ltn'])
  if (output === undefined) return []
  for (const line of output.split('\n')) {
    const match = /^\s*LISTEN\s+\d+\s+\d+\s+\S*?:(\d+)\s/.exec(line)
    if (match === null) continue
    const port = Number(match[1])
    if (port >= PRIVILEGED_PORT_CEILING) ports.add(port)
  }
  return [...ports].sort((a, b) => a - b)
}

/**
 * Collect every endpoint worth probing, in the order the evidence ranks it.
 * @param options - detection settings.
 * @returns the candidate list, deduplicated by host:port.
 */
async function collectCandidates(options) {
  const candidates = []
  const seen = new Set()
  const add = (candidate) => {
    const key = `${candidate.host}:${candidate.port}`
    if (seen.has(key)) return
    seen.add(key)
    candidates.push(candidate)
  }

  // A value the user exported is the most direct statement of where the proxy is.
  const env = options.env ?? process.env
  for (const [name, value] of Object.entries(env)) {
    if (!/^(https?|all)_proxy$/i.test(name)) continue
    const parsed = parseProxyEndpoint(value)
    if (parsed !== undefined) add({ ...parsed, origin: 'env', source: `环境变量 ${name}` })
  }

  if (options.useSystemProxy !== false) {
    const system = await options.readSystemProxy()
    if (system !== undefined) add({ ...system, origin: 'system', source: 'Windows 系统代理' })
  }

  for (const known of options.knownEndpoints ?? KNOWN_ENDPOINTS) {
    const isNumber = typeof known === 'number'
    const port = isNumber ? known : known.port
    // A bare number carries no client name, so it names itself rather than repeating the wrapper.
    const source = isNumber ? `常见端口 ${known}` : `常见端口（${known.client}）`
    add({ host: options.host, port, origin: 'known', source })
  }

  return { candidates, seen }
}

/**
 * Sort results into the order the report shows: usable first, then the near misses, and within a
 * verdict the more direct evidence first.
 * @param results - probed candidates.
 * @returns a new sorted array.
 */
function rankResults(results) {
  return [...results].sort((left, right) => {
    const kind = (KIND_RANK[left.kind] ?? 9) - (KIND_RANK[right.kind] ?? 9)
    if (kind !== 0) return kind
    const origin = (ORIGIN_RANK[left.origin] ?? 9) - (ORIGIN_RANK[right.origin] ?? 9)
    if (origin !== 0) return origin
    return left.port - right.port
  })
}

/**
 * Find the HTTP proxy this machine is running.
 *
 * The scan pass is deliberately deferred. The candidate list covers the clients actually in use, so
 * the common case resolves in about half a second; enumerating and probing every listening port costs
 * an order of magnitude more and is only worth paying when nothing standard answered.
 * @param options - detection settings; `host` defaults to loopback.
 * @returns the endpoint when one was found, plus every probed candidate for the report.
 */
export async function detectProxyEndpoint(options = {}) {
  const startedAt = Date.now()
  const settings = {
    host: options.host ?? '127.0.0.1',
    probeTimeoutMs: options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    scanListeningPorts: options.scanListeningPorts !== false,
    scanTimeoutMs: options.scanTimeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS,
    useSystemProxy: options.useSystemProxy !== false,
    knownEndpoints: options.knownEndpoints ?? KNOWN_ENDPOINTS,
    env: options.env,
    // The two machine-reading steps are injectable so a test can supply its own world. Without that
    // seam a suite inevitably asserts against whatever proxy the developer's machine happens to run,
    // and changing a port there would change the test outcome.
    readSystemProxy: options.readSystemProxy ?? readSystemProxy,
    listListeningPorts: options.listListeningPorts ?? listListeningPorts,
  }

  const { candidates, seen } = await collectCandidates(settings)
  const firstPass = await mapLimit(candidates, DEFAULT_CONCURRENCY, async (candidate) => {
    const probe = await probeEndpoint(candidate.host, candidate.port, settings.probeTimeoutMs)
    return { ...candidate, ...probe }
  })

  let results = firstPass
  let scanned = false
  if (!firstPass.some((result) => result.kind === KIND.HTTP_PROXY) && settings.scanListeningPorts) {
    const listening = await settings.listListeningPorts()
    const fresh = []
    for (const port of listening.slice(0, MAX_SCAN_PORTS)) {
      const key = `${settings.host}:${port}`
      if (seen.has(key)) continue
      seen.add(key)
      fresh.push({ host: settings.host, port, origin: 'scan', source: '本机监听端口' })
    }
    if (fresh.length > 0) {
      scanned = true
      const scanTimeout = Math.min(settings.probeTimeoutMs, settings.scanTimeoutMs)
      const secondPass = await mapLimit(fresh, DEFAULT_CONCURRENCY, async (candidate) => {
        const probe = await probeEndpoint(candidate.host, candidate.port, scanTimeout)
        return { ...candidate, ...probe }
      })
      results = [...firstPass, ...secondPass]
    }
  }

  const ranked = rankResults(results)
  const usable = ranked.filter((result) => result.kind === KIND.HTTP_PROXY)
  return {
    ok: usable.length > 0,
    endpoint: usable[0],
    results: ranked,
    scanned,
    durationMs: Date.now() - startedAt,
  }
}
