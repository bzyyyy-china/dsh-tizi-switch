# Proxy switch

**Flip this Harness instance's outbound proxy at runtime — no restart, no system-proxy change, no port configuration.**

[中文](https://github.com/bzyyyy-china/dsh-tizi-switch/blob/main/README.md) | English ｜ [Changelog](https://github.com/bzyyyy-china/dsh-tizi-switch/blob/main/CHANGELOG.md)

---

## The problem

DSH resolves its proxy policy from the environment (`HTTP_PROXY` / `HTTPS_PROXY`) once, at launch. Nothing changes it afterwards. That leaves two bad options:

- **Proxy client not running at launch** → the whole process stays direct, and reaching a blocked network means restarting DSH.
- **Proxy hardcoded in the environment** → with the client closed, every request points at a dead port and DSH breaks.

This plugin reuses DSH's own `@deepseek-ai/dsh-http-proxy` package — whose install already returns a disposer — to swap the process-wide undici dispatcher while the session keeps running.

## It finds your proxy port itself

Clash Verge listens on 7897, v2rayN puts its HTTP inbound on 10809, sing-box on 2080, a bare shadowsocks client on 1080. Shipping any one of those as a default silently breaks the plugin for everyone using another, so it does not assume one. Detection asks this machine, in this order:

1. **The proxy environment** — `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`
2. **The Windows system proxy** — the address your client last published
3. **Default ports of the common clients** — fifteen of them, from Clash to v2rayA

**Detection runs once, when the plugin loads**, and the answer is cached for the life of the process. Turning the proxy on and off afterwards reuses it and never scans again: sweeping a machine's ports repeatedly is exactly the pattern endpoint security software treats as port scanning, and a proxy switcher has no business looking like that. `proxy_status` reports `N/3` — normally exactly `1/3`. Detection is capped at three runs per process, so repeatedly pressing "turn on the proxy" cannot turn it into a port sweeper.

**The result lives in memory only; it never rewrites your configuration.** Saying "turn on the proxy" installs that endpoint directly, so you do not have to fill in a port.

Two cases re-detect, and neither scans:

1. **Nothing was found at load** (DSH started before the client) → re-detected on the next switch
2. **The cached port stopped answering** (you switched clients, or closed one) → re-detected to the new port

The second one matters: trusting the load-time cache alone would leave the plugin refusing forever after a client switch, even with a working proxy running.

**But the port is always verified before it is installed.** The cache records where the proxy was seen, not a promise that it is still there. Installing a dead port turns every request into `ECONNREFUSED` — precisely what this plugin exists to prevent. So `proxy_on` makes one loopback connect first (one known port, no enumeration), installs only if it answers, and otherwise reports that the client may have exited and stays direct.

### Optional: scan every listening port

When the client was moved to an unusual port and the steps above find nothing, opt in explicitly:

```yaml
- id: tizi-switch
  config:
    scanListeningPorts: true
```

Off by default, because a full port sweep is far likelier to raise an alert, and the known ports already cover almost everyone.

When enabled it runs **at most once per process** (at load); later re-detections read only the environment, the Windows system proxy, and the fifteen known ports. `proxy_status` reports whether the scan pass has been spent.

### An open port is not a proxy

The DSH Web UI, a dev server, and a local database all accept connections. Pointing the dispatcher at one of them turns every outbound request into a failure, so a candidate is accepted only when it answers the HTTP `CONNECT` preamble — the exchange every HTTP proxy implements and nothing else routinely does.

The probe asks to CONNECT to `127.0.0.1:9`, a discard port with no listener, so **no tunnel is ever established and nothing is sent to your current node**.

### SOCKS is recognised, not used

DSH accepts only `http://` and `https://` proxy URLs. When the only port found is SOCKS (v2rayN's 10808, v2rayA's 20171), the plugin says so and asks you to enable an HTTP or mixed inbound instead of pretending the switch worked.

## Four tools

| Tool | What it does |
|---|---|
| `proxy_on` | Finds the local proxy port automatically; installs it when it answers, reports why when it does not, and leaves routing untouched on failure. |
| `proxy_off` | Removes the proxy and returns to direct connections, effective immediately. |
| `proxy_status` | Read-only: whether requests are proxied now, which port is in use, and whether it answers. |
| `proxy_detect` | Read-only: every proxy port found on this machine, and why each was accepted or rejected. |

## Automatic fallback

Once installed, every request of this process points at the proxy port. If the client is closed, each request fails with `ECONNREFUSED` in milliseconds — which from the user's side is simply "the network broke".

The plugin therefore probes the port every 3 seconds and drops the proxy when it stops answering:

| Stage | Result |
|---|---|
| Request with the proxy on | HTTP 200 |
| Client closed | `ECONNREFUSED` (~2 ms) |
| Health poll (≤3 s) | Automatic return to direct |
| Request after fallback | HTTP 200 |

**Why it does not switch itself back on**: a proxy client's port can flap repeatedly while it starts. Automatic recovery would flip routing back and forth with no predictable state, so the fallback is one-way; say "turn on the proxy" once the client is ready again.

Disable it with `healthCheckMs: 0`.

## Install

From the **Plugins** page, or:

```sh
dsh plugin add dsh-tizi-switch
```

## Configuration

**Nothing to configure.** Detection handles the port.

To pin a port and skip detection:

```yaml
- id: tizi-switch
  config:
    port: 7897
```

Even a pinned port is verified first: a dead port is refused and routing stays direct, rather than breaking DSH.

| Option | Default | Meaning |
|---|---|---|
| `host` | `127.0.0.1` | Proxy host, used for both detection and installation |
| `port` | unset = detect | Pinning a port skips detection |
| `probeTimeoutMs` | `400` | Per-port probe budget |
| `healthCheckMs` | `3000` | Health poll interval for the enabled port; `0` disables it |
| `scanListeningPorts` | `false` | Whether to sweep every listening port (may raise security-software alerts) |
| `reportLimit` | `5` | How many ports `proxy_status` lists |

## Scope and limits

**Covered**: model calls, `web_fetch`, `web_search`, and HTTP MCP servers — anything that reaches `globalThis.fetch`.

**Not covered** (upstream boundaries, not choices made here):
- Model-authored script subprocesses, which deliberately do not inherit a proxy URL that may carry credentials.
- The telemetry channel, which uses `node:http`.
- `web_fetch` to a literal private address.

**This process only**: the change applies to this process's global dispatcher and affects no other program. The plugin reads the Windows system proxy to learn where the client is listening; it never writes it.

**Not supported**: proxies that require a username and password. These are detected and reported, not installed.

## Design notes

**Why verify the port before switching.** A dead port fails fast with `ECONNREFUSED`. Installing the proxy blindly would mean that forgetting to start the client breaks DSH outright. So `proxy_on` completes the HTTP handshake first, refuses when nothing answers correctly, and does not touch current routing.

**Why `proxy_off` does not await the disposer.** The trailing `agent.close()` inside `dispose()` waits for in-flight connections to finish, which can take tens of seconds. But the restoring `setGlobalDispatcher` at the head of the disposer is **synchronous** — routing has already switched back. Awaiting the whole disposer would make the tool call look hung.

**Why the dynamic imports.** When the plugin is linked locally or installed into a profile, the profile's own `node_modules` does not resolve `@deepseek-ai/*`. The plugin therefore locates the installation through `DSH_INSTALL_DIR` and imports by `file://` URL.

**Why detection has no dependencies.** Every probe is a bare `node:net` socket, so the package stays dependency-free.

## Compatibility

Requires DSH `0.2.2-rc.2` or later. It depends on `installProxyFromEnvironment` from `@deepseek-ai/dsh-http-proxy` returning a disposer, which is what makes hot switching possible. If that API changes, this plugin needs a matching update.

## License

[MIT](https://github.com/bzyyyy-china/dsh-tizi-switch/blob/main/LICENSE)
