#!/bin/bash
# Posts a one-line Telegram message when a Brain unit enters the failed state.
# Invoked as brain-alert@<unit>.service via OnFailure=; %i arrives as $1.
#
# Deliberately quiet about its own problems: a missing/incomplete
# /etc/brain/alert.env or an unreachable Telegram API logs to the journal and
# exits 0, so the alert path can never keep a failed unit failing.
#
# Message content is identifiers only (host, unit, Result, exit status) —
# never journal lines, so no log text can leak into the chat.
set -u

unit="${1:-unknown}"
token="${BRAIN_ALERT_TELEGRAM_TOKEN:-}"
chat_id="${BRAIN_ALERT_TELEGRAM_CHAT_ID:-}"

if [[ -z "$token" || -z "$chat_id" ]]; then
  echo "brain-alert: alert.env not configured; failure of $unit not delivered" >&2
  exit 0
fi

result="$(systemctl show "$unit" --property=Result --value 2>/dev/null || true)"
exec_status="$(systemctl show "$unit" --property=ExecMainStatus --value 2>/dev/null || true)"
text="⚠️ $(hostname -s): $unit failed"
text+=$'\n'"result=${result:-unknown} exit=${exec_status:-unknown}"
text+=$'\n'"$(date -u '+%Y-%m-%d %H:%M:%S') UTC"

if ! curl --silent --show-error --max-time 10 --retry 2 --retry-delay 3 \
  --data-urlencode "chat_id=$chat_id" \
  --data-urlencode "text=$text" \
  "https://api.telegram.org/bot$token/sendMessage" >/dev/null; then
  echo "brain-alert: Telegram delivery failed for $unit" >&2
fi
exit 0
