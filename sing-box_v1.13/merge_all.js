const { name, type = "0", rules: rules_file } = $arguments;

// ============================================================================
// 私人固定节点极简合并脚本（零自动测速、零地区嵌套）
// 模板策略组只使用两个占位符：
//   {all}              全部有效固定节点（保持订阅原有排列顺序）
//   {relay_candidates} 全部有效节点剔除自身带 "detour": "Relay" 的落地节点
//                      （防止链式代理回环死循环）
// 规则：
//   - 仅过滤显式标记 [停用]/[维护]/[disabled]/停用/维护中 的节点；
//   - 节点 tag 去重（与模板已有 tag 一并去重），顺序保持订阅原样；
//   - 若没有任何节点使用 "detour": "Relay"，自动删除 Relay 组（界面极简）；
//   - 展开后为空的 selector 组会被迭代清理，系统出站与 route.final
//     目标组永不删除，保证不输出空 outbounds；
//   - 模板中没有任何占位符时，回退旧版行为（全部节点追加进每个分组）。
// ============================================================================

const KEEP_RELAY_IF_UNUSED = false;

// 极简停用过滤（仅显式标记停用/维护的节点）
const DISABLED_REGEX = /^\s*\[(?:停用|维护|disabled)\]|停用|维护中/i;

const PLACEHOLDERS = ["{all}", "{relay_candidates}"];

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

// 4. 过滤停用节点，并按 tag 去重（含与模板已有 tag 去重），保持原顺序
const existingTags = new Set(config.outbounds.map(o => o.tag));
proxies = proxies.filter(p => {
  if (!p.tag || existingTags.has(p.tag)) return false;
  if (DISABLED_REGEX.test(p.tag)) return false;
  existingTags.add(p.tag);
  return true;
});

// 5. 添加新节点到 outbounds
config.outbounds.push(...proxies);

// 6. 占位符桶：{all} 全部节点；{relay_candidates} 剔除 detour=Relay 的节点
const allTags = proxies.map(p => p.tag);
const relayDetourTags = new Set(proxies.filter(p => p.detour === "Relay").map(p => p.tag));
const buckets = {
  "{all}": allTags,
  "{relay_candidates}": allTags.filter(t => !relayDetourTags.has(t)),
};

// 7. 遍历分组注入节点：含占位符按占位符展开；无占位符回退旧版追加行为
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
    group.outbounds.push(...buckets["{relay_candidates}"]);
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
  // 9. Relay 按需存在：没有任何节点 detour 到 Relay 时删除 Relay 组，
  //    并清理其他组对它的引用。
  if (!KEEP_RELAY_IF_UNUSED && relayDetourTags.size === 0) {
    config.outbounds = config.outbounds.filter(o => o.tag !== "Relay");
    config.outbounds.forEach(g => {
      if (Array.isArray(g.outbounds)) {
        g.outbounds = g.outbounds.filter(t => t !== "Relay");
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
