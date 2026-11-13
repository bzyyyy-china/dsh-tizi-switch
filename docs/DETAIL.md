# 梯子开关

需要访问无法直连的网络时，把本实例的出网请求切到本地代理；平时保持直连。

## 为什么需要它

DSH 只在**启动时**读一次 `HTTP_PROXY` / `HTTPS_PROXY`。这带来两个尴尬：

- 启动时代理客户端没开，这个进程就一直是直连，想翻墙只能重启
- 把代理写死在环境变量里，客户端没开时所有请求指向空端口，DSH 直接瘫痪

本插件在运行中替换 undici 的全局 dispatcher，于是两种状态随时可切。

## 三个工具

| 工具 | 作用 |
|---|---|
| `proxy_on` | 探测代理端口，通了就装上并立即生效；不通则如实报告并保持直连 |
| `proxy_off` | 卸掉代理，恢复直连，立即生效 |
| `proxy_status` | 只读查询：现在走不走代理、端口通不通 |

## 配置

默认 `127.0.0.1:7897`（Clash Verge 的 `mixed-port`）。在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: tizi-switch
  config:
    host: 127.0.0.1
    port: 7897
    probeTimeoutMs: 1200
```

## 边界

- **不读写操作系统代理设置**，只改本进程内的 dispatcher
- **不影响其他软件**，浏览器照常
- **只作用于本进程**：模型调用、`web_fetch`、`web_search`、HTTP MCP
- 不覆盖模型自己写的脚本子进程、以及使用 `node:http` 的遥测通道（上游既定边界）

## 关键实现细节

**切换前先探测端口**：指向死端口会快速 `ECONNREFUSED`。无脑装代理等于把「忘了开客户端」变成「DSH 瘫掉」。所以 `proxy_on` 先做一次 TCP 探测，探不到就拒绝且不改动当前路由。

**`proxy_off` 不等 dispose 完成**：`dispose()` 尾部的 `agent.close()` 要等在途连接结束，可能几十秒；但头部还原 dispatcher 是同步的，路由早已切回。等待整个 dispose 只会让调用看起来卡死。

**为什么用动态导入**：本地 link 安装时，profile 的 `node_modules` 解析不到 `@deepseek-ai/*`，所以要经 `DSH_INSTALL_DIR` 用 `file://` URL 导入。

## 许可证

[MIT](../LICENSE)
