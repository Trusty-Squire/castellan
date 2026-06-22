#!/usr/bin/env bash
# BOT RUNNER (palette) — wraps bot.js. Resolves the provider's base URL from the env var the
# test harness sets (VOUCHFLOW_BASE_URL / TRUSTYSQUIRE_BASE_URL), or a 4th arg for others.
# Usage: ./run-bot.sh <provider> <email> <password> [base_url]
set -euo pipefail
provider="${1:?provider}"; email="${2:?email}"; password="${3:?password}"
case "$provider" in
  vouchflow)     base="${VOUCHFLOW_BASE_URL:-${4:-}}" ;;
  trustysquire)  base="${TRUSTYSQUIRE_BASE_URL:-${4:-}}" ;;
  *)             base="${4:-}" ;;
esac
node bot.js "$provider" "$email" "$password" "$base"
