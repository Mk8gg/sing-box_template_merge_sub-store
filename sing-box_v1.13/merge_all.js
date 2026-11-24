const { name, type = "0", rules: rules_file } = $arguments;

// ============================================================================
// 自建节点专版合并脚本（去机场化）
// 模板中可在策略组 outbounds 里使用占位符，脚本按节点名称自动展开：
//   {all} 全部有效节点   {hk} 香港   {jp} 日本   {us} 美国   {sg} 新加坡
//   {tw} 台湾   {eu} 欧洲   {landing} 落地/家宽/原生节点   {other} 其他地区
//   {relay_candidates} 可作为 Relay 前置的节点（自动剔除 detour 指向 Relay
//                      的落地节点，防止链式代理回环死循环）
// 健壮性机制：
//   - 默认只过滤显式标记 [停用]/[维护]/[disabled]/停用/维护中 的节点，
//     不使用机场广告词过滤，避免误杀自建节点命名；
//   - 某地区只有 1 台节点时，自动删除其 `-自动选择` urltest 组并清理引用
//     （单节点防套娃）；
//   - 展开后为空的 selector/urltest 组会被迭代清理，并同步移除上层引用，
//     保证 0 空组、0 断链；系统出站（direct、route.final 目标组、
//     dns/http_clients 的 detour 目标组）永不删除；
//   - 模板中没有任何占位符时，自动回退旧版行为（全部节点追加进每个分组）。
// ============================================================================

// 极简停用过滤（仅显式标记停用/维护的节点）
const DISABLED_REGEX = /^\s*\[(?:停用|维护|disabled)\]|停用|维护中/i;

// 地区 / 属性分类正则（贴合自建机房命名）
const REGION_REGEX = {
  "{hk}": /🇭🇰|香港|(?<![A-Za-z])HKG?(?![A-Za-z])|hong\s*kong/i,
  "{jp}": /🇯🇵|日本|东京|大阪|京都|(?<![A-Za-z])JPN?(?![A-Za-z])|japan|tokyo|osaka/i,
  "{us}": /🇺🇸|美国|纽约|洛杉矶|旧金山|芝加哥|休斯顿|迈阿密|西雅图|波士顿|华盛顿|拉斯维加斯|圣何塞|达拉斯|(?<![A-Za-z])USA?(?![A-Za-z])|america|united\s*states|los\s*angeles|san\s*jose|seattle/i,
  "{sg}": /🇸🇬|新加坡|狮城|(?<![A-Za-z])SGP?(?![A-Za-z])|singapore/i,
  "{tw}": /🇹🇼|台湾|台北|高雄|(?<![A-Za-z])TWN?(?![A-Za-z])|taiwan/i,
  "{eu}": /🇬🇧|🇩🇪|🇫🇷|🇳🇱|英国|伦敦|德国|法兰克福|法国|巴黎|荷兰|阿姆斯特丹|欧洲|(?<![A-Za-z])(?:UK|GB|DE|FR|NL|EU)(?![A-Za-z])|london|frankfurt|amsterdam|europe/i,
  "{landing}": /落地|家宽|住宅|原生\s*IP|家庭宽带|(?<![A-Za-z])(?:Exit|Landing|ISP|RES)(?![A-Za-z])|residential/i,
};

const PLACEHOLDERS = ["{all}", "{hk}", "{jp}", "{us}", "{sg}", "{tw}", "{eu}", "{landing}", "{other}", "{relay_candidates}"];

// 1. 读取模板
let config = JSON.parse($files[0]);

// 2. 先追加自定义规则（如果传了 rules_file 且能成功读取）
if (rules_file) {
  try {
    let customRulesRaw = await produceArtifact({
      type: "file",
      name: rules_file,
    });
    if (customRulesRaw) {
      let customRules = JSON.parse(customRulesRaw);
      // 找到 clash_mode === "global" 规则索引（不判断 outbound）
      let idx = config.route.rules.findIndex(r => r.clash_mode === "global");
      if (idx !== -1) {
        const existingRulesStr = new Set(config.route.rules.map(r => JSON.stringify(r)));
        customRules = customRules.filter(r => !existingRulesStr.has(JSON.stringify(r)));
        config.route.rules.splice(idx + 1, 0, ...customRules);
      } else {
        config.route.rules.push(...customRules);
      }
    } else {
      // 文件没找到或为空，什么都不做，安静跳过
    }
  } catch (e) {
    // 解析或其它错误也不抛出，跳过规则插入
  }
}

// 3. 拉取订阅或合集节点
let proxies = await produceArtifact({
  name,
  type: /^1$|col/i.test(type) ? "collection" : "subscription",
  platform: "sing-box",
  produceType: "internal",
});

// 4. 过滤停用节点，并按 tag 去重（含与模板已有 tag 去重），
//    避免 sing-box 因重复 tag 启动校验失败
const existingTags = new Set(config.outbounds.map(o => o.tag));
proxies = proxies.filter(p => {
  if (!p.tag || existingTags.has(p.tag)) return false;
  if (DISABLED_REGEX.test(p.tag)) return false;
  existingTags.add(p.tag);
  return true;
});

// 5. 添加新节点到 outbounds
config.outbounds.push(...proxies);

// 6. 准备 tag 列表与分类桶
const allTags = proxies.map(p => p.tag);
const terminalTags = proxies.filter(p => !p.detour).map(p => p.tag);
// Relay 防回环：本身 detour 指向 Relay 的落地节点，绝不能成为 Relay 的候选
const relayDetourTags = new Set(proxies.filter(p => p.detour === "Relay").map(p => p.tag));
const tagsMatching = re => proxies.filter(p => re.test(p.tag)).map(p => p.tag);
const regionBuckets = {};
for (const key of Object.keys(REGION_REGEX)) regionBuckets[key] = tagsMatching(REGION_REGEX[key]);
const regionUnion = new Set(
  ["{hk}", "{jp}", "{us}", "{sg}", "{tw}", "{eu}"].flatMap(k => regionBuckets[k])
);
const buckets = {
  "{all}": allTags,
  ...regionBuckets,
  "{other}": proxies.filter(p => !regionUnion.has(p.tag)).map(p => p.tag),
  "{relay_candidates}": allTags.filter(t => !relayDetourTags.has(t)),
};

// 7. 遍历分组注入节点：模板含占位符时按占位符展开；否则回退旧版追加行为。
//    旧版模板下 Relay 分组仍只追加无 detour 的终端节点。
const templateUsesPlaceholders = config.outbounds.some(
  g => Array.isArray(g.outbounds) && g.outbounds.some(t => PLACEHOLDERS.includes(t))
);
config.outbounds.forEach(group => {
  if (!Array.isArray(group.outbounds) || group.tag === "Direct-Out") return;

  if (templateUsesPlaceholders) {
    const expanded = [];
    group.outbounds.forEach(t => {
      if (PLACEHOLDERS.includes(t)) expanded.push(...buckets[t]);
      else expanded.push(t);
    });
    group.outbounds = expanded;
  } else if (group.tag === "Relay") {
    group.outbounds.push(...terminalTags.filter(t => !relayDetourTags.has(t)));
  } else {
    group.outbounds.push(...allTags);
  }
});

// 8. 分组内去重
config.outbounds.forEach(group => {
  if (Array.isArray(group.outbounds)) {
    group.outbounds = [...new Set(group.outbounds)];
  }
});

if (templateUsesPlaceholders) {
  // 9. 单节点防套娃：`-自动选择` urltest 组若只剩 1 个成员（单台自建机），
  //    删除该组并从所有父级组中移除对它的引用（父组经占位符已直含该节点）。
  const soloAutoTags = new Set(
    config.outbounds
      .filter(o => o.type === "urltest" && o.tag.endsWith("-自动选择") && Array.isArray(o.outbounds) && o.outbounds.length === 1)
      .map(o => o.tag)
  );
  if (soloAutoTags.size) {
    config.outbounds = config.outbounds.filter(o => !soloAutoTags.has(o.tag));
    config.outbounds.forEach(g => {
      if (Array.isArray(g.outbounds)) {
        g.outbounds = g.outbounds.filter(t => !soloAutoTags.has(t));
      }
    });
  }

  // 10. 迭代清理空策略组：删除展开后为空的 selector/urltest 组，并迭代移除
  //     其他组对已删组/不存在 tag 的引用，直到稳定。
  //     受保护永不删除：direct 等系统出站、route.final 指向的组、
  //     dns servers / http_clients / clash_api 的 detour 目标组。
  const protectedTags = new Set();
  config.outbounds.forEach(o => {
    if (o.type === "direct" || !Array.isArray(o.outbounds)) protectedTags.add(o.tag);
  });
  if (config.route && config.route.final) protectedTags.add(config.route.final);
  const collectDetour = obj => {
    if (!obj || typeof obj !== "object") return;
    if (typeof obj.detour === "string") protectedTags.add(obj.detour);
    Object.values(obj).forEach(collectDetour);
  };
  collectDetour(config.dns);
  collectDetour(config.http_clients);
  if (config.experimental && config.experimental.clash_api) {
    const det = config.experimental.clash_api.external_ui_download_detour;
    if (typeof det === "string") protectedTags.add(det);
  }

  let changed = true;
  while (changed) {
    changed = false;
    const aliveTags = new Set(config.outbounds.map(o => o.tag));
    config.outbounds.forEach(g => {
      if (Array.isArray(g.outbounds)) {
        const before = g.outbounds.length;
        g.outbounds = g.outbounds.filter(t => aliveTags.has(t));
        if (g.outbounds.length !== before) changed = true;
      }
    });
    const emptyTags = new Set(
      config.outbounds
        .filter(o => (o.type === "selector" || o.type === "urltest") && Array.isArray(o.outbounds) && o.outbounds.length === 0 && !protectedTags.has(o.tag))
        .map(o => o.tag)
    );
    if (emptyTags.size) {
      config.outbounds = config.outbounds.filter(o => !emptyTags.has(o.tag));
      changed = true;
    }
  }
}

// 11. 输出最终配置
$content = JSON.stringify(config, null, 2);
