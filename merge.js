const args = typeof $arguments === "object" && $arguments !== null ? $arguments : {};
const { name, type = "0", rules: rules_file, keep_relay } = args;

// ============================================================================
// sing-box 模板节点合并脚本（兼容 v1.14 占位符模板 & v1.15 传统模板）
// 参数（通过 Sub-Store 脚本参数 #name=...&type=0&rules=...&keep_relay=0 传入）：
//   name        必填，Sub-Store 中的单条订阅或组合订阅名称
//   type        可选，"0"/subscription（默认）或 "1"/collection
//   rules       可选，Sub-Store 中的自定义规则 JSON 文件名
//   keep_relay  可选，"1"/"true" 时即使无节点使用 detour 也保留中转组
//
// 模板占位符：
//   {all}              全部有效节点（保持订阅原有排列顺序）
//   {relay_candidates} 只含不带 detour 字段的节点（防止链式代理回环）
//
// 安全与健壮性保障：
//   1. 输入参数与模板结构校验，错误信息清晰可定位；
//   2. 过滤显式停用/维护节点与常见机场信息伪节点（流量/到期/官网/公告等）；
//   3. 同名节点（含与模板已有 tag 冲突）自动重命名（#2, #3...），不静默丢弃；
//   4. 中转组兼容识别（含 {relay_candidates} 占位符，或名为 🔗 链式中转 / Relay）；
//   5. 自定义规则插入锚点修复：优先插入 clash_mode 之后，回退 hijack-dns / sniff
//      之后或顶部，绝不落到 resolve / geoip 之后成为死规则；
//   6. 空组清理同步修复 route.rules 悬空引用；0 节点时为受保护策略组兜底直连出站，
//      保证永远不会生成空 outbounds 导致 sing-box 启动失败。
// ============================================================================

const KEEP_RELAY_IF_UNUSED = false;
const keepRelayIfUnused =
  KEEP_RELAY_IF_UNUSED || /^(?:1|true|yes)$/i.test(String(keep_relay || ""));

// 停用 / 维护节点过滤
const DISABLED_REGEX =
  /^\s*\[(?:停用|维护|disabled)\]|停用|维护中|暂停服务|暂不可用|已过期|已到期/i;

// 常见机场信息伪节点过滤（流量、到期、官网、重置、通知、客服等）
const PSEUDO_NODE_REGEX =
  /(?:剩余流量|流量剩余|套餐到期|到期时间|过期时间|有效期至|距离下次重置|下次重置|流量重置|官网|最新网址|发布页|备用网址|防失联|群组|频道|通知|公告|工单|客服|售后|续费|充值|返利|邀请码|更新订阅|重新订阅|订阅转换|订阅地址|无法使用|请更新|节点异常|测试节点|traffic|expire|expired|remaining|reset\s*date|official\s*site)/i;

const PLACEHOLDERS = ["{all}", "{relay_candidates}"];
const RELAY_TAG_REGEX = /^(?:🔗\s*)?(?:链式中转|中转|relay)$/i;

const logWarn = msg => {
  if (typeof console !== "undefined" && typeof console.log === "function") {
    console.log(`[merge.js] ${msg}`);
  }
};

// 1. 输入参数与模板校验
if (typeof name !== "string" || !name.trim()) {
  throw new Error(
    "[merge.js] 缺少必要参数 name（请传入 Sub-Store 中的订阅或组合订阅名称）"
  );
}

if (!Array.isArray($files) || typeof $files[0] !== "string" || !$files[0].trim()) {
  throw new Error("[merge.js] 未读取到有效的模板文件（$files[0] 为空）");
}

let config;
try {
  config = JSON.parse($files[0]);
} catch (e) {
  throw new Error(`[merge.js] 模板 JSON 解析失败: ${e.message}`);
}

if (!config || typeof config !== "object" || !Array.isArray(config.outbounds)) {
  throw new Error("[merge.js] 模板格式无效：缺少 outbounds 数组");
}

if (!config.route || typeof config.route !== "object") {
  config.route = { rules: [] };
}
if (!Array.isArray(config.route.rules)) {
  config.route.rules = [];
}

// 2. 追加自定义规则（智能锚点定位，避免追加到 resolve / geoip 之后失效）
if (typeof rules_file === "string" && rules_file.trim()) {
  try {
    const customRulesRaw = await produceArtifact({
      type: "file",
      name: rules_file.trim(),
    });
    if (typeof customRulesRaw === "string" && customRulesRaw.trim()) {
      const parsed = JSON.parse(customRulesRaw);
      let customRules = [];
      if (Array.isArray(parsed)) {
        customRules = parsed;
      } else if (parsed && Array.isArray(parsed.rules)) {
        customRules = parsed.rules;
      } else if (parsed && typeof parsed === "object") {
        customRules = [parsed];
      }

      const existingRulesStr = new Set(config.route.rules.map(r => JSON.stringify(r)));
      customRules = customRules.filter(r => {
        if (!r || typeof r !== "object" || Array.isArray(r)) return false;
        const key = JSON.stringify(r);
        if (existingRulesStr.has(key)) return false;
        existingRulesStr.add(key);
        return true;
      });

      if (customRules.length > 0) {
        const rules = config.route.rules;
        let insertIdx = -1;

        // 优先锚点：最后一条 clash_mode === "global"（或任意 clash_mode）之后
        for (let i = rules.length - 1; i >= 0; i--) {
          if (rules[i] && rules[i].clash_mode === "global") {
            insertIdx = i + 1;
            break;
          }
        }
        if (insertIdx === -1) {
          for (let i = rules.length - 1; i >= 0; i--) {
            if (rules[i] && typeof rules[i].clash_mode === "string") {
              insertIdx = i + 1;
              break;
            }
          }
        }
        // 次级锚点：hijack-dns 之后 -> sniff 之后 -> 顶部 0
        if (insertIdx === -1) {
          const hijackIdx = rules.findIndex(r => r && r.action === "hijack-dns");
          if (hijackIdx !== -1) insertIdx = hijackIdx + 1;
        }
        if (insertIdx === -1) {
          const sniffIdx = rules.findIndex(r => r && r.action === "sniff");
          if (sniffIdx !== -1) insertIdx = sniffIdx + 1;
        }
        if (insertIdx === -1) insertIdx = 0;

        rules.splice(insertIdx, 0, ...customRules);
      }
    }
  } catch (e) {
    logWarn(`跳过自定义规则文件 "${rules_file}": ${e.message}`);
  }
}

// 3. 拉取订阅或组合订阅节点
let rawProxies = [];
try {
  const fetched = await produceArtifact({
    name: name.trim(),
    type: /^1$|col/i.test(String(type)) ? "collection" : "subscription",
    platform: "sing-box",
    produceType: "internal",
  });
  if (Array.isArray(fetched)) {
    rawProxies = fetched;
  } else {
    logWarn(`订阅 "${name}" 未返回节点数组，将启用空节点安全兜底`);
  }
} catch (e) {
  logWarn(`拉取订阅 "${name}" 失败（${e.message}），将启用空节点安全兜底`);
}

// 4. 过滤无效/停用/伪节点，并对同名节点自动重命名（#2, #3...）
const usedTags = new Set(
  config.outbounds
    .map(o => (o && typeof o.tag === "string" ? o.tag : ""))
    .filter(Boolean)
);

const proxies = [];
for (const p of rawProxies) {
  if (!p || typeof p !== "object" || typeof p.type !== "string" || typeof p.tag !== "string") {
    continue;
  }
  const baseTag = p.tag.trim();
  if (!baseTag) continue;
  if (DISABLED_REGEX.test(baseTag) || PSEUDO_NODE_REGEX.test(baseTag)) continue;

  let finalTag = baseTag;
  if (usedTags.has(finalTag)) {
    let seq = 2;
    while (usedTags.has(`${baseTag} #${seq}`)) seq++;
    finalTag = `${baseTag} #${seq}`;
  }
  usedTags.add(finalTag);
  proxies.push(finalTag === p.tag ? p : { ...p, tag: finalTag });
}

// 5. 识别模板模式与中转组（兼容占位符模式 & v1.15 传统模板）
const templateUsesPlaceholders = config.outbounds.some(
  g => g && Array.isArray(g.outbounds) && g.outbounds.some(t => PLACEHOLDERS.includes(t))
);

const relayGroupTags = new Set();
config.outbounds.forEach(g => {
  if (!g || g.type !== "selector" || !Array.isArray(g.outbounds)) return;
  if (g.outbounds.includes("{relay_candidates}") || RELAY_TAG_REGEX.test(g.tag || "")) {
    relayGroupTags.add(g.tag);
  }
});

// 6. 添加有效节点到 outbounds，并构建占位符桶
config.outbounds.push(...proxies);

const allTags = proxies.map(p => p.tag);
const relayCandidates = proxies
  .filter(p => typeof p.detour !== "string" || !p.detour.trim())
  .map(p => p.tag);
const proxyDetourTargets = new Set(
  proxies
    .map(p => (typeof p.detour === "string" ? p.detour.trim() : ""))
    .filter(Boolean)
);

const buckets = {
  "{all}": allTags,
  "{relay_candidates}": relayCandidates,
};

// 7. 遍历策略组注入节点
config.outbounds.forEach(group => {
  if (!group || !Array.isArray(group.outbounds)) return;
  if (group.type !== "selector" && group.type !== "urltest") return;

  if (templateUsesPlaceholders) {
    if (group.type === "urltest" && group.outbounds.length === 0) {
      group.outbounds = [...allTags];
      return;
    }
    const expanded = [];
    group.outbounds.forEach(t => {
      if (PLACEHOLDERS.includes(t)) expanded.push(...buckets[t]);
      else expanded.push(t);
    });
    group.outbounds = expanded;
  } else {
    if (relayGroupTags.has(group.tag)) {
      group.outbounds.push(...relayCandidates);
    } else if (group.type === "urltest") {
      group.outbounds.push(...allTags);
    } else {
      group.outbounds.push(...allTags);
    }
  }
});

// 8. 策略组内去重
config.outbounds.forEach(group => {
  if (group && Array.isArray(group.outbounds)) {
    group.outbounds = [...new Set(group.outbounds)];
  }
});

// 9. 链式中转按需保留（占位符与传统模板均生效）
if (!keepRelayIfUnused && relayGroupTags.size > 0) {
  const unusedRelayTags = new Set(
    [...relayGroupTags].filter(tag => !proxyDetourTargets.has(tag))
  );
  if (unusedRelayTags.size > 0) {
    config.outbounds = config.outbounds.filter(o => !unusedRelayTags.has(o.tag));
    config.outbounds.forEach(g => {
      if (g && Array.isArray(g.outbounds)) {
        g.outbounds = g.outbounds.filter(t => !unusedRelayTags.has(t));
      }
    });
  }
}

// 10. 确保存在直连出站作为空节点安全兜底目标
let directOutbound = config.outbounds.find(o => o && o.type === "direct" && o.tag);
if (!directOutbound) {
  directOutbound = { type: "direct", tag: "direct" };
  config.outbounds.push(directOutbound);
}
const directTag = directOutbound.tag;

// 11. 收集受保护 tag（系统出站、route.final、被 dns/http_clients/services/clash_api/proxy detour 直接引用的组）
const protectedTags = new Set([directTag]);
config.outbounds.forEach(o => {
  if (o && (!Array.isArray(o.outbounds) || o.type === "direct" || o.type === "block")) {
    if (o.tag) protectedTags.add(o.tag);
  }
});
if (typeof config.route.final === "string" && config.route.final) {
  protectedTags.add(config.route.final);
}
proxyDetourTargets.forEach(tag => protectedTags.add(tag));

const collectDetour = obj => {
  if (!obj || typeof obj !== "object") return;
  if (typeof obj.detour === "string" && obj.detour) protectedTags.add(obj.detour);
  if (typeof obj.download_detour === "string" && obj.download_detour) {
    protectedTags.add(obj.download_detour);
  }
  Object.values(obj).forEach(collectDetour);
};
collectDetour(config.dns);
collectDetour(config.http_clients);
collectDetour(config.services);
collectDetour(config.route.rule_set);
if (config.experimental && config.experimental.clash_api) {
  const det = config.experimental.clash_api.external_ui_download_detour;
  if (typeof det === "string" && det) protectedTags.add(det);
}

// 12. 迭代清理空策略组与无效引用（占位符与传统模板均生效）
let changed = true;
while (changed) {
  changed = false;
  const aliveTags = new Set(config.outbounds.map(o => o.tag));

  config.outbounds.forEach(g => {
    if (g && Array.isArray(g.outbounds)) {
      const before = g.outbounds.length;
      g.outbounds = g.outbounds.filter(t => aliveTags.has(t));
      if (g.outbounds.length !== before) changed = true;
    }
  });

  const emptyTags = new Set(
    config.outbounds
      .filter(
        o =>
          o &&
          (o.type === "selector" || o.type === "urltest") &&
          Array.isArray(o.outbounds) &&
          o.outbounds.length === 0 &&
          !protectedTags.has(o.tag)
      )
      .map(o => o.tag)
  );

  if (emptyTags.size > 0) {
    config.outbounds = config.outbounds.filter(o => !emptyTags.has(o.tag));
    changed = true;
  }
}

// 13. 空节点安全兜底：受保护组若展开后仍为空，注入直连出站避免 sing-box 启动崩溃
config.outbounds.forEach(g => {
  if (!g || (g.type !== "selector" && g.type !== "urltest")) return;
  if (!Array.isArray(g.outbounds) || g.outbounds.length === 0) {
    g.outbounds = [directTag];
    logWarn(`策略组 "${g.tag}" 无可用节点，已自动兜底为 "${directTag}"`);
  }
  if (g.type === "selector" && typeof g.default === "string" && !g.outbounds.includes(g.default)) {
    delete g.default;
  }
});

// 14. 同步修复 route.final、route.rules 及其他模块的悬空出站引用
const finalAliveTags = new Set(config.outbounds.map(o => o.tag));

if (typeof config.route.final !== "string" || !finalAliveTags.has(config.route.final)) {
  config.route.final = directTag;
}
const fallbackOutbound = config.route.final;

config.route.rules.forEach(rule => {
  if (rule && typeof rule.outbound === "string" && !finalAliveTags.has(rule.outbound)) {
    logWarn(`路由规则引用的出站 "${rule.outbound}" 已被清理，已重指向 "${fallbackOutbound}"`);
    rule.outbound = fallbackOutbound;
  }
});

const repairDetour = (obj, isDns = false) => {
  if (!obj || typeof obj !== "object") return;
  if (typeof obj.detour === "string" && obj.detour && !finalAliveTags.has(obj.detour)) {
    if (isDns) {
      if (fallbackOutbound !== directTag && finalAliveTags.has(fallbackOutbound)) {
        logWarn(`DNS detour "${obj.detour}" 无效，已重指向 "${fallbackOutbound}"`);
        obj.detour = fallbackOutbound;
      } else {
        logWarn(`DNS detour "${obj.detour}" 无效，已移除（sing-box 1.12+ 禁止 detour 指向空 direct）`);
        delete obj.detour;
      }
    } else {
      obj.detour = directTag;
    }
  }
  if (
    typeof obj.download_detour === "string" &&
    obj.download_detour &&
    !finalAliveTags.has(obj.download_detour)
  ) {
    obj.download_detour = directTag;
  }
  Object.values(obj).forEach(v => repairDetour(v, isDns));
};
repairDetour(config.dns, true);
repairDetour(config.http_clients);
repairDetour(config.services);
repairDetour(config.route.rule_set);
if (
  config.experimental &&
  config.experimental.clash_api &&
  typeof config.experimental.clash_api.external_ui_download_detour === "string" &&
  config.experimental.clash_api.external_ui_download_detour &&
  !finalAliveTags.has(config.experimental.clash_api.external_ui_download_detour)
) {
  config.experimental.clash_api.external_ui_download_detour = directTag;
}

// 15. 输出最终配置
$content = JSON.stringify(config, null, 2);
