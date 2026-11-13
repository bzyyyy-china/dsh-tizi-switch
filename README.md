# 梯子开关

**在 DeepSeek Harness 运行中随时切换出网代理 —— 不重启，不改系统代理。**

> 本项目主要面向中文用户：插件本身以中文提供交互，工具的返回文案也是中文。
> 英文说明见 [README.en.md](README.en.md)，仅供阅读参考。

---

## 它解决什么问题

DSH 的代理配置是**进程启动时读一次**环境变量（`HTTP_PROXY` / `HTTPS_PROXY`），运行中无法改变。这带来两个尴尬：

- **启动时代理客户端没开** → 整个进程一直直连，想翻墙只能重启 DSH
- **把代理写死在环境变量里** → 代理客户端没开时，所有请求指向一个空端口，DSH 直接瘫痪

本插件复用 DSH 自带的 `@deepseek-ai/dsh-http-proxy` 包（它的 install 返回一个 disposer，本来就是装/卸成对设计的），在运行中替换 undici 的全局 dispatcher，于是两种状态可以随时切。

## 三个工具

| 工具 | 作用 |
|---|---|
| `proxy_on` | 探测代理端口，通了就装上代理并立即生效；不通则如实报告并保持直连 |
| `proxy_off` | 卸掉代理，恢复直连，立即生效 |
| `proxy_status` | 只读查询：现在走不走代理、代理端口通不通 |

对模型说「开代理」「关代理」「现在走代理吗」即可。

## 安装

在 DSH 的**插件**页面添加，或：

```sh
dsh plugin add dsh-tizi-switch
```

本地开发也可以直接指向目录：

```sh
dsh plugin add /path/to/dsh-tizi-switch
```

## 配置

默认代理地址 `127.0.0.1:7897`（Clash Verge 的 `mixed-port`）。**如果你用的是别的代理客户端，端口通常不同**，常见值：

| 客户端 | 常见 HTTP 端口 |
|---|---|
| Clash Verge / mihomo | `7897`（`mixed-port`） |
| Clash for Windows | `7890` |
| v2rayN | `10809`（HTTP）、`10808`（SOCKS） |
| sing-box / Hiddify | `2080` 或 `7890` |

在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: tizi-switch
  config:
    host: 127.0.0.1
    port: 7897
    probeTimeoutMs: 1200
```

> 注意：本插件只接受 `http://` 代理。填 SOCKS 端口会连不上 —— 请填客户端的**混合端口或 HTTP 端口**。

## 设计取舍

**为什么切换前要探测端口。** 指向一个没人监听的端口时，请求会以 `ECONNREFUSED` 快速失败。如果无脑装上代理，用户忘了开代理客户端就等于把 DSH 弄瘫。所以 `proxy_on` 先做一次 1.2 秒的 TCP 探测，探不到就拒绝、并且**不改动当前路由**。

**为什么只改进程内 dispatcher。** DSH 官方文档明确写了它不读操作系统的代理设置。本插件沿用这个边界：只替换 undici 的全局 dispatcher，不碰注册表、不碰系统代理开关。因此它和你的浏览器互不影响 —— 你可以单独给 DSH 开梯子，浏览器照常。

**为什么 `proxy_off` 不等待 dispose 完成。** `dispose()` 尾部的 `agent.close()` 会等在途连接自然结束，可能有几十秒。但 disposer 开头的 `setGlobalDispatcher` 还原是**同步**的 —— 路由早就切回去了。所以这里 fire-and-forget，避免工具调用看起来像卡死。

## 覆盖范围与边界

**覆盖**：模型调用、`web_fetch`、`web_search`、HTTP 类型的 MCP —— 任何走 `globalThis.fetch` 的请求。

**不覆盖**（上游既定边界，非本插件的取舍）：
- 模型自己写的脚本子进程 —— 不继承代理变量，因为其中可能带凭据
- 使用 `node:http` 的遥测通道
- 指向字面私有地址的 `web_fetch`

**只作用于本进程**：改的是本进程的全局 dispatcher，不影响机器上其他程序。

## 兼容性

需要 DSH `0.2.2-rc.2` 及以上。依赖的 `@deepseek-ai/dsh-http-proxy` 提供 `installProxyFromEnvironment`，其返回值是一个 disposer —— 这是热切换的基础。若未来该 API 变化，插件需要相应调整。

## 为什么用动态导入

插件以本地 link 或 profile 包的形式存在时，profile 自己的 `node_modules` 里并不会解析到 `@deepseek-ai/*`。因此这里通过 `DSH_INSTALL_DIR` 定位安装目录，用 `file://` URL 动态导入。这也是为什么 `index.js` 顶部没有静态 import 那三个包。

## 许可证

[MIT](LICENSE)
