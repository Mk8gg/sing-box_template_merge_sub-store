#!/bin/sh
# OpenWRT sing-box 配置安全自动更新脚本（配合 crontab 使用）
# 特性：并发锁 -> 下载至同分区临时文件 -> sing-box check 校验 -> 备份 -> 原子替换 -> 启动检查与失败回滚 -> 日志截断

set -u

# ==================== 用户配置区 ====================
CONFIG_URL="<http://你在sub-store中的模板链接>"
CONFIG_DIR="/etc/sing-box"
CONFIG_FILE="${CONFIG_DIR}/config.json"
BACKUP_FILE="${CONFIG_DIR}/config.json.bak"
LOG_FILE="${CONFIG_DIR}/update.log"
MAX_LOG_LINES=200
CURL_CONNECT_TIMEOUT=15
CURL_MAX_TIME=45
CURL_RETRY=3
LOCK_DIR="/tmp/sing-box-update.lock"
# ====================================================

TMP_FILE="${CONFIG_DIR}/.config.json.tmp.$$"

mkdir -p "$CONFIG_DIR"

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >> "$LOG_FILE"
  # 日志截断，防止 OpenWRT 闪存被写满
  if [ -f "$LOG_FILE" ]; then
    line_count="$(wc -l < "$LOG_FILE" 2>/dev/null || echo 0)"
    if [ "$line_count" -gt "$MAX_LOG_LINES" ]; then
      tail -n "$MAX_LOG_LINES" "$LOG_FILE" > "${LOG_FILE}.tmp" 2>/dev/null && mv -f "${LOG_FILE}.tmp" "$LOG_FILE"
    fi
  fi
}

cleanup() {
  rm -f "$TMP_FILE" "${LOG_FILE}.tmp"
  rmdir "$LOCK_DIR" 2>/dev/null || true
}

is_singbox_running() {
  if [ -x /etc/init.d/sing-box ] && /etc/init.d/sing-box running >/dev/null 2>&1; then
    return 0
  fi
  if command -v pidof >/dev/null 2>&1 && pidof sing-box >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

# 防止定时任务重叠执行
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  log "⚠️ 已有更新任务正在运行，跳过本次执行"
  exit 0
fi
trap cleanup EXIT INT TERM

# 检查是否已替换占位链接
case "$CONFIG_URL" in
  ""|*"你在sub-store中的模板链接"*|"<"*)
    log "❌ 请先修改脚本中的 CONFIG_URL 为实际的 Sub-Store 模板链接"
    exit 1
    ;;
esac

log "开始更新 ${CONFIG_FILE}"

# 1. 下载到同分区临时文件（-f 避免将 HTTP 4xx/5xx 页面写入配置）
if ! curl -fsSL \
  --connect-timeout "$CURL_CONNECT_TIMEOUT" \
  --max-time "$CURL_MAX_TIME" \
  --retry "$CURL_RETRY" \
  --retry-delay 2 \
  -o "$TMP_FILE" \
  "$CONFIG_URL"; then
  log "❌ 下载失败，保持现有配置不变"
  exit 1
fi

if [ ! -s "$TMP_FILE" ]; then
  log "❌ 下载文件为空，放弃更新"
  exit 1
fi

# 2. 使用 sing-box check 校验新配置合法性
SING_BOX_BIN="$(command -v sing-box 2>/dev/null || echo /usr/bin/sing-box)"
if [ -x "$SING_BOX_BIN" ]; then
  CHECK_OUT="$("$SING_BOX_BIN" check -c "$TMP_FILE" 2>&1)"
  if [ $? -ne 0 ]; then
    log "❌ sing-box check 校验失败，放弃替换：${CHECK_OUT}"
    exit 1
  fi
else
  log "⚠️ 未找到 sing-box 可执行文件，跳过语法预校验"
fi

# 3. 若内容无变化则跳过重启，减少网络中断
if [ -f "$CONFIG_FILE" ] && cmp -s "$TMP_FILE" "$CONFIG_FILE"; then
  log "ℹ️ 配置文件无变化，跳过重启"
  exit 0
fi

# 4. 备份当前可用配置
if [ -f "$CONFIG_FILE" ]; then
  if ! cp -p "$CONFIG_FILE" "$BACKUP_FILE"; then
    log "❌ 备份旧配置失败，放弃替换"
    exit 1
  fi
fi

# 5. 原子替换目标配置
if ! mv -f "$TMP_FILE" "$CONFIG_FILE"; then
  log "❌ 原子替换配置失败"
  exit 1
fi
chmod 600 "$CONFIG_FILE" 2>/dev/null || true

# 6. 重启服务并验证进程状态，失败则自动回滚
log "校验通过，重启 sing-box 服务"
/etc/init.d/sing-box stop >/dev/null 2>&1 || true
if [ -x /etc/init.d/dnsmasq ]; then
  /etc/init.d/dnsmasq restart >/dev/null 2>&1 || true
fi
/etc/init.d/sing-box start >/dev/null 2>&1 || true

sleep 2
if is_singbox_running; then
  log "✅ 更新并重启成功"
  exit 0
fi

# 启动失败 -> 自动回滚
log "❌ sing-box 启动失败，开始回滚至备份配置"
if [ -f "$BACKUP_FILE" ]; then
  cp -pf "$BACKUP_FILE" "$CONFIG_FILE"
  /etc/init.d/sing-box start >/dev/null 2>&1 || true
  sleep 2
  if is_singbox_running; then
    log "⚠️ 已回滚至旧配置并恢复运行，请检查新模板内容"
  else
    log "❌ 回滚后 sing-box 仍未运行，请手动排查日志（logread | grep sing-box）"
  fi
else
  log "❌ 未找到备份文件，无法自动回滚"
fi
exit 1
