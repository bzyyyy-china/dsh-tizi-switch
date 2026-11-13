# Proxy switch

**Flip this Harness instance's outbound proxy at runtime — no restart, no system-proxy change.**

[中文](https://github.com/bzyyyy-china/dsh-tizi-switch/blob/main/README.md) | English

---

## The problem

DSH resolves its proxy policy from the environment (`HTTP_PROXY` / `HTTPS_PROXY`) once, at launch. Nothing changes it afterwards. That leaves two bad options:

- **Proxy client not running at launch** → the whole process stays direct, and reaching a blocked network means restarting DSH.
- **Proxy hardcoded in the environment** → with the client closed, every request points at a dead port and DSH breaks.

This plugin reuses DSH's own `@deepseek-ai/dsh-http-proxy` package — whose install already returns a disposer — to swap the process-wide undici dispatcher while the session keeps running.

## Three tools

| Tool | What it does |
|---|---|
| `proxy_on` | Probes the proxy port; if it answers, installs the proxy and takes effect immediately. If not, reports it and leaves routing untouched. |
| `proxy_off` | Removes the proxy and returns to direct connections, effective immediately. |
| `proxy_status` | Read-only: whether requests are proxied now, and whether the proxy port answers. |

## Install

From the **Plugins** page, or:

```sh
dsh plugin add dsh-tizi-switch
```

For local development, point at the directory:

```sh
dsh plugin add /path/to/dsh-tizi-switch
```

## Configuration

The default proxy address is `127.0.0.1:7897` (Clash Verge's `mixed-port`). Override it in the profile's `cordis.patch.yml`:

```yaml
- id: tizi-switch
  config:
    host: 127.0.0.1
    port: 7897
    probeTimeoutMs: 1200
```

## Design notes

**Why probe the port before switching.** A dead port fails fast with `ECONNREFUSED`. Installing the proxy blindly would mean that forgetting to start the proxy client breaks DSH outright. So `proxy_on` spends 1.2 seconds on a TCP probe first, refuses when nothing answers, and **does not touch current routing**.

**Why only the in-process dispatcher.** DSH's documentation states plainly that it does not read the operating system's proxy settings. This plugin keeps that boundary: it replaces undici's global dispatcher and touches neither the registry nor the system-proxy switch. The plugin and your browser therefore stay independent — you can turn the ladder on for DSH alone.

**Why `proxy_off` does not await the disposer.** The trailing `agent.close()` inside `dispose()` waits for in-flight connections to finish, which can take tens of seconds. But the restoring `setGlobalDispatcher` at the head of the disposer is **synchronous** — routing has already switched back. Awaiting the whole disposer would make the tool call look hung, so the close is left to settle on its own.

## Scope and limits

**Covered**: model calls, `web_fetch`, `web_search`, and HTTP MCP servers — anything that reaches `globalThis.fetch`.

**Not covered** (upstream boundaries, not choices made here):
- Model-authored script subprocesses, which deliberately do not inherit a proxy URL that may carry credentials.
- The telemetry channel, which uses `node:http`.
- `web_fetch` to a literal private address.

**This process only**: the change applies to this process's global dispatcher and affects no other program on the machine.

## Compatibility

Requires DSH `0.2.2-rc.2` or later. It depends on `installProxyFromEnvironment` from `@deepseek-ai/dsh-http-proxy` returning a disposer, which is what makes hot switching possible. If that API changes, this plugin needs a matching update.

## Why the dynamic imports

When the plugin is linked locally or installed into a profile, the profile's own `node_modules` does not resolve `@deepseek-ai/*`. The plugin therefore locates the installation through `DSH_INSTALL_DIR` and imports by `file://` URL — which is why `index.js` has no static imports for those three packages.

## License

[MIT](https://github.com/bzyyyy-china/dsh-tizi-switch/blob/main/LICENSE)
