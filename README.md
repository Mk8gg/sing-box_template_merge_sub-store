# sing-box_template_merge_sub-store

## 模板概览

本仓库提供适用于 **sing-box v1.14** 与 **sing-box v1.15** 的配置模板，以及配套的 Sub-Store 节点合并脚本 [merge.js](merge.js) 和 OpenWRT 自动更新脚本。

| 目录 | 说明 | 适用核心版本 |
| --- | --- | --- |
| `sing-box_v1.14/` | RealIP 模板（IPv4），完整 7 层路由规则 + 中文/Emoji 策略组 + Zashboard 面板 | sing-box 1.14+ |
| `sing-box_v1.14/fakeip模板（ipv6支持）/` | FakeIP 模板（支持 IPv6，使用标准 `198.18.0.0/15` 与 `fc00::/18` 网段） | sing-box 1.14+ |
| `sing-box_v1.15/` | 精简 RealIP 模板，启用原生 `sing-tun`（移除废弃 `stack`）与 Optimistic DNS 缓存 | sing-box 1.15+ |

每套模板均提供两个平台版本：

- **`singbox.json`（Linux / OpenWRT 网关版）**：启用 `auto_redirect: true`，管理面板默认监听 `0.0.0.0:9090`（方便局域网管理）。**安全提示：路由器/局域网部署强烈建议为 `secret` 设置强密码。**
- **`singbox_win.json`（Windows / macOS / Android / iOS 客户端版）**：移除 `auto_redirect`，开启 `platform.http_proxy`，管理面板监听地址锁定为 `127.0.0.1:9090` 防止局域网未授权访问。

## 关于防 DNS 泄露与安全加固

本仓库模板默认内置多层防泄露与拦截机制：

1. **无污染 DNS 分流**：
   - 私有域名交由 `local_dns` 解析，广告与 HTTPDNS 域名在 DNS 层直接返回 `NXDOMAIN`。
   - 对 `HTTPS` / `SVCB`（Type 65/64）记录返回 `NOERROR` 空响应，避免 ECH 破坏嗅探或 `ipv4hint`/`ipv6hint` 绕过 FakeIP；RealIP 模板同时屏蔽 `AAAA` 防止 IPv6 泄露。
   - 国内精准子集与 `geosite-cn` 走加密国内 DoH/DoT（`223.5.5.5` / `1.12.12.12`），其余域名经代理节点走境外 DoH（`8.8.8.8`），不向本地运营商泄露境外查询。
   - `v1.14` 模板采用“精准代理例外 -> 国内直连子集 -> 海外应用分流 -> `geosite-cn` / `geosite-geolocation-!cn` -> `resolve` + GeoIP 兜底”的 7 层有序规则；`v1.15` 模板保留轻量设计（`cnsite` 仅做 DNS 分流，路由兜底以无污染解析后的 `cnip` 为准）。
2. **防绕过与防 WebRTC 泄露**：
   - 在拦截层屏蔽 **DoT/DoQ 853 端口**、**HTTPDNS 域名与常见厂商 IP**、**STUN 协议**（防止 WebRTC 暴露真实 IP）、PCDN 及非国内 QUIC（UDP 443 / `protocol: quic`）。
   - 所有远程规则集均使用 `.srs` 二进制格式，降低内存占用与加载耗时。

## 使用步骤（Sub-Store + `merge.js`）

1. 在 Sub-Store 的「文件管理」中上传所需的模板 JSON（如 `singbox.json` 或 `singbox_win.json`）。
2. 记下 Sub-Store 中单条订阅或组合订阅的名称。
3. 编辑该模板文件，添加一个「脚本操作」，链接填写：

```text
https://ghfast.top/raw.githubusercontent.com/Mk8gg/sing-box_template_merge_sub-store/main/merge.js#name=<订阅名称>&type=<订阅类型>
```

支持的参数：

- `name`（必填）：Sub-Store 中的单条订阅或组合订阅名称。
- `type`（可选，默认 `0`）：`0` 表示单条订阅，`1` 表示组合订阅（`collection`）。
- `rules`（可选）：Sub-Store 中的自定义规则 JSON 文件名，脚本会自动将其插入到 `clash_mode` 之后（若模板无 `clash_mode`，则回退插入到 `hijack-dns`/`sniff` 之后，避免落入末尾成为死规则）。
- `keep_relay`（可选，默认 `0`）：设为 `1` 时，即使当前没有任何节点配置 `detour` 指向中转组，也强制保留链式中转策略组。

`merge.js` 内置机制：

- 自动过滤显式停用/维护节点与常见机场信息伪节点（剩余流量、套餐到期、官网、重置时间等）。
- 同名节点（或与模板内置 tag 冲突的节点）自动追加 `#2`、`#3` 后缀重命名，不再静默丢弃。
- 同时兼容 `v1.14` 占位符模板（`{all}`、`{relay_candidates}`、`🔗 链式中转`）与 `v1.15` 传统模板（`Relay`、`Auto`）。
- 订阅拉取为空或策略组被清理时，自动为受保护策略组兜底直连出站，并同步修复 `route.rules` 中的悬空出站引用，防止 `sing-box` 启动报错。

## OpenWRT 自动更新脚本

`sing-box_v1.14/OpenWRT配套脚本/` 与 `sing-box_v1.15/OpenWRT配套脚本/` 中的更新脚本可配合 `crontab` 使用（需使用官方 ipk 安装，支持 `/etc/init.d/sing-box`）。使用前请将脚本顶部 `CONFIG_URL` 替换为你的 Sub-Store 模板链接。

脚本执行流程：并发锁防重入 -> `curl -fsSL` 带超时重试下载到同分区临时文件 -> `sing-box check` 预校验 -> 内容无变化跳过重启 -> 备份旧配置 -> `mv` 原子替换 -> 重启后检测进程状态，失败则自动回滚旧配置 -> 自动截断 `update.log`（最多保留 200 行，保护路由器闪存）。

> 在 sing-box 1.14+ 中，旧版的 MAC 地址过滤与仅常用端口代理脚本已不再需要，可直接使用模板中的路由规则与 `exclude` 字段实现。

## 关于链式代理及中继节点分组

模板中内置了链式中转策略组（`v1.14` 为 `🔗 链式中转`，`v1.15` 为 `Relay`，默认直连），用于配合链式代理落地节点使用。

在你的落地节点配置中添加：

```json
"detour": "🔗 链式中转"
```

（若使用 `v1.15` 模板，则填写 `"detour": "Relay"`。）

当你在某个应用分组（如 `🎬 Netflix` 或 `🎵 TikTok`）中选中该落地节点时，访问路径为：

```text
本机 -> 中转组选中的前置节点（或直连） -> 链式落地节点 -> 目标站点
```

- `{relay_candidates}`（以及 `v1.15` 的 `Relay` 组）仅填充**不带 `detour` 字段**的节点，从根源避免链式代理回环。
- 默认情况下，若订阅中没有任何节点通过 `detour` 指向中转组，`merge.js` 会自动清理该中转组以保持面板精简；如需始终显示，请在脚本参数中附加 `&keep_relay=1`。

## 鸣谢

- 原始合并脚本灵感参考自 [xishang0128](https://github.com/xishang0128)
- 推荐搭配 [Sub-Store](https://github.com/sub-store-org/Sub-Store) 管理订阅与模板
