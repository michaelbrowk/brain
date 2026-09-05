#!/usr/bin/env bash
# One-command install of Brain on Ubuntu.
#   curl -fsSL https://raw.githubusercontent.com/michaelbrowk/brain/main/install.sh | sudo bash
# Re-running it upgrades. `--uninstall` removes everything except the notes.
set -euo pipefail

DRY="${BRAIN_INSTALL_DRY_RUN:-0}"

say() { printf '%s\n' "$*"; }
die() { printf '%s\n' "$*" >&2; exit 1; }
# Every side effect passes through here. Under dry run it prints the plan.
run() {
  if [ "$DRY" = "1" ]; then say "would run: $*"; return 0; fi
  "$@"
}

preflight() {
  [ "$(id -u)" = "0" ] || die "Run this with sudo: it installs Docker and needs root for that."
  command -v apt-get >/dev/null || die "This installer needs apt (Ubuntu or Debian); no apt-get here."
  case "$(uname -m)" in
    x86_64|aarch64) ;;
    *) die "Brain ships for x86_64 and aarch64; this machine is $(uname -m)." ;;
  esac
  local mb; mb="$(free -m | awk '/^Mem:/ {print $2}')"
  [ "$mb" -ge 1536 ] || die "Brain and its mail service want 2 GB of RAM; this machine has ${mb} MB."
  [ "$mb" -ge 2048 ] || say "Note: less than 2 GB of RAM; it runs, with little headroom."
  command -v curl >/dev/null || run apt-get install -y curl
}

# Placeholder until the uninstall task lands. It returns instead of calling
# die so shellcheck sees the exit below as reachable. Under set -e a non-zero
# return ends the script the same way.
uninstall() {
  printf '%s\n' "uninstall is not implemented yet" >&2
  return 1
}

main() {
  if [ "${1:-}" = "--uninstall" ]; then uninstall; exit 0; fi
  preflight
  say "install.sh: skeleton"    # replaced task by task
}
main "$@"
