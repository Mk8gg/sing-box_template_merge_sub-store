# sing-box_template_merge_sub-store

## 关于防 DNS 泄露

本仓库的 sing-box 及 mihomo 配置中，自带防 DNS 泄露功能，并且较市面主流的防泄漏方案有所优化，其运行逻辑如下：

1. cn 域名列表外的所有域名，均会通过节点代理向 1.1.1.1 这类境外公共 dns 发起解析请求，不会有任何本地的 dns 请求记录，并且可以确保解析结果是真实无污染无劫持的。
2. 根据 1 获得的无污染 ip，匹配 cn 的 ip 列表，决定是否需要代理

也就是说，假如有一个站点 xx.com，其本身不在 cn 的 domain 列表内，但他的真实 ip 属 cn 境内，那么他还是会走直连，只是 dns 环节经过节点代理。
而市面上流行的相当多旧方案，在这种情况下却会将 xx.com 无脑进行代理，这是非常不合理且效率低下的。
（事实上你甚至可以用有污染的 ip 进行判断，由于只要不匹配 cn 的 ip 规则，均会通过代理，所以实际连接不会有什么影响）

**注：路由规则中只有cnip而没有cnsite并非漏写，而是特意设计，即：cnsite仅用来做dns分流，真实的路由分流只取决于真实ip是否属于cnip** 

## sing-box配置模板使用说明

提供两套配置模板及一个 js 脚本，js 脚本使用参考下方的使用步骤

两个版本间的唯一区别是 inbounds 中是否含有 auto_redirect 字段，这个特性不光 windows，即使是安卓、iOS 同样并不支持

因此诸如 OpenWRT、Debian 之类的 linux 发行版应使用无后缀版本（开启 auto_redirect，作为主路由或旁路网关实现透明代理）

其他如 Windows、安卓、iOS 均应使用有后缀的版本（不使用 auto_redirect）

p.s. 使用openwrt配套脚本需要满足：确保使用官方 ipk 方式安装（需要支持/etc/init.d/sing-box 指令）
openwrt端的**mac地址过滤、仅常用端口代理**脚本在1.14中已不再需要（config中的bypass、exclude字段可实现等同效果）

## 使用步骤（默认模式）

1. 在 sub-store 上传 singbox_template.json
2. 记住在 sub-store 中你的单条订阅或组合订阅的名称
3. 在 sub-store 的文件管理功能中编辑 singbox_template.json 添加一个脚本操作，并且选择链接：

```
https://ghfast.top/raw.githubusercontent.com/Mk8gg/sing-box_template_merge_sub-store/main/merge.js#name=<你在sub-store中的订阅名称>&type=<在sub-store中的订阅类型>
```

type 可以赋值 0 或 1,0 表示单条订阅，1 表示组合订阅

4. 添加脚本操作后再次访问 sub-store 中的 singbox_template.json，就已经是把节点信息正确插入的完整可用配置了

## 关于链式代理及中继节点分组

使用本项目的 sing-box 模板，会发现多出了一个“Relay”策略组，并且默认选择是“Direct-Out”，他要配合你的“链式代理落地节点”使用。

何为链式代理落地节点：
在 sing-box 中，你可以在你的节点信息最后添加一行

```json
"detour": "其他节点tag或分组tag"
```

这样当你在例如“TikTok”分组中选中这条链式代理节点时，完整的访问路径就会是

本机 -> "其他节点 tag 或分组 tag" -> 这条链式节点（作为落地）

因此使用本项目的配置模板，你只需要指定特定节点的 detour 为“Relay”，并在面板中切换“Relay”，就可以指定不同的链式前置

（也就是说，当你通过这种方式并且定义链式节点的分流规则时（如：将 netflix 分流至链式节点），就仅需要在两台 vps 配置代理协议本身来实现 sniproxy+dnsmasq 的落地机分流解锁功能）

这种方式更加灵活且更加全面，可以随时将落地节点切换为直连使用

## 私人固定节点极简扁平版

本仓库当前面向**私人固定自建节点**（少数几台自己的 VPS，如 VLESS/REALITY、Hysteria 2、SS2022），sing-box v1.14 模板与 merge.js 已按极简扁平结构重构，并整合 [MyClash](https://github.com/Mk8gg/MyClash) 的应用分流规则顺序：

- **零自动测速、零地区嵌套**：没有任何 urltest 组，也没有地区/分类中间套壳组。第一排总出口组 `Default` 直接平铺全部固定节点（占位符 `{all}`，保持订阅里的排列顺序），并开启 `interrupt_exist_connections`——点哪台就立刻全切到哪台。
- **应用分流默认跟随第一排**：AI、Google、YouTube、GitHub、Telegram、TikTok、Twitter、Meta、Netflix、Spotify、Crypto、Microsoft、Apple、Steam、Emby、PayPal、FCM 与“漏网之鱼”（route.final）全部是扁平 selector，第一项指向 `Default` 自动跟随第一排选择，后面直接平铺全部固定节点，需要给某个 App 单独锁一台 VPS 时直接点节点即可。merge.js 仅过滤显式标记 `[停用]` / `[维护]` / `[disabled]` / `停用` / `维护中` 的节点并做 tag 去重，不做任何机场式名称过滤。
- **Relay 按需出现**：给某台落地节点在 Sub-Store 里加上 `"detour": "Relay"` 后，在 `Relay` 组里选 `Direct-Out` 即直连落地机，选某台优化线路入口机即形成“中转 -> 落地”链式代理；merge.js 会自动把落地节点本身从 Relay 候选（`{relay_candidates}`）中剔除，绝不回环。若订阅里没有任何节点使用 Relay，`Relay` 组会被自动删除，不占界面。
- **完整适配 sing-box 1.14.0+**：无 `download_detour`、`store_rdrc`、`independent_cache` 等弃用字段与警告；规则集统一使用 GitHub 官方直连源 `raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing` 的 `.srs`（与 MyClash 同源），经顶层 `http_clients` + `route.default_http_client: "proxy-client"` 走代理组更新；防 DNS 泄露设计（geosite-cn 仅用于 DNS 分流、路由只认 geoip-cn、节点域名走国内直连 DNS 解析）保留不变。

### 模板区分

- `singbox.json`（含 fakeip 版）：OpenWrt / Linux 透明代理用，保留 `auto_redirect` 与局域网面板（`0.0.0.0:9090`）。
- `singbox_win.json`（含 fakeip 版）：Android / iOS / Windows 用，不含 `auto_redirect` / `interface_name` / `dns_mode`，面板仅监听 `127.0.0.1:9090`。

## 鸣谢

这段 js 脚本是由 chatgpt 参考[xishang0128](https://github.com/xishang0128)大佬所写

[神器 sub-store](https://github.com/sub-store-org/Sub-Store)太 tm 好用了，强烈推荐！！！
