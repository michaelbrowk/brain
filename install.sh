#!/usr/bin/env bash
# One-command install of Brain on Ubuntu.
#   curl -fsSL https://raw.githubusercontent.com/michaelbrowk/brain/main/install.sh | sudo bash
# Re-running it upgrades. `--uninstall` removes everything except the notes.
set -euo pipefail

DRY="${BRAIN_INSTALL_DRY_RUN:-0}"
INSTALL_DIR="${BRAIN_INSTALL_DIR:-/opt/brain}"
RELEASES_API="${BRAIN_RELEASES_API:-https://api.github.com/repos/michaelbrowk/brain/releases/latest}"
RAW="https://raw.githubusercontent.com/michaelbrowk/brain"

# Under `curl ... | sudo bash` stdin is the script itself, so questions go to
# the terminal when there is one; the tests have no terminal and answer on stdin.
# Fd 3 is that source. It is a dup of stdin, not a reopen of /dev/stdin, which
# is refused on a socket and restarts a file from the top on Linux.
# With no terminal, fd 3 is the script's own stdin. Under `curl ... | bash` that
# pipe is already at end of input by the time main runs, bash having read the
# script up to its last line, so a question there ends in the no-terminal
# sentence instead of eating script text. Keep main the last line.
if { : < /dev/tty; } 2>/dev/null; then exec 3</dev/tty; else exec 3<&0; fi

say() { printf '%s\n' "$*"; }
die() { printf '%s\n' "$*" >&2; exit 1; }
# A read on fd 3 that hit end of input: nothing to ask on.
no_terminal() { die "No terminal to ask on. Set BRAIN_PASSWORD and BRAIN_DOMAIN to install without prompts."; }
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
  # An odd free output counts as no memory, so the refusal below names 0 MB
  # instead of bash choking on a non-number.
  case "$mb" in ''|*[!0-9]*) mb=0 ;; esac
  [ "$mb" -ge 1536 ] || die "Brain and its mail service want 2 GB of RAM; this machine has ${mb} MB."
  [ "$mb" -ge 2048 ] || say "Note: less than 2 GB of RAM; it runs, with little headroom."
  case "$INSTALL_DIR" in /*) ;; *) die "BRAIN_INSTALL_DIR must be an absolute path." ;; esac
  command -v curl >/dev/null || run apt-get install -y curl
  command -v openssl >/dev/null || run apt-get install -y openssl
}

ensure_docker() {
  if docker compose version >/dev/null 2>&1; then say "Docker: present"; return; fi
  say "Docker: installing from Docker's apt repository (this replaces Ubuntu's docker.io package if it is present)"
  run apt-get update
  run apt-get install -y ca-certificates curl gnupg
  run install -m 0755 -d /etc/apt/keyrings
  run bash -c 'curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc'
  run chmod a+r /etc/apt/keyrings/docker.asc
  run bash -c 'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list'
  run apt-get update
  run apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  run systemctl enable --now docker
}

resolve_release() {
  local json
  json="$(curl -fsSL "$RELEASES_API" 2>/dev/null)" || die "Could not read the latest release from GitHub. Check the network and try again."
  # Quits at the first tag_name line. The here-string, a temp file, leaves no
  # writer for that early quit to kill, so a huge payload cannot end the run
  # through SIGPIPE under pipefail with no sentence.
  TAG="$(sed -n '/tag_name/{s/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p;q;}' <<< "$json")"
  [ -n "$TAG" ] || die "Could not read the latest release from GitHub. Check the network and try again."
  say "Latest release: $TAG"
}

# The install directory and the notes folder are made for real under dry run
# too: they are the plan's output. Ownership and the download are side effects
# and go through run.
layout() {
  NOTES_DIR="$INSTALL_DIR/notes"
  mkdir -p "$INSTALL_DIR" "$NOTES_DIR"
  # The image runs as uid 1000, and Brain refuses a notes folder it cannot write.
  run chown 1000:1000 "$NOTES_DIR"
  run curl -fsSL "$RAW/v$TAG/ops/docker/docker-compose.yml" -o "$INSTALL_DIR/docker-compose.yml"
  # Under dry run the download above is only announced, so a placeholder
  # stands in and the later steps still have a compose file to read.
  if [ "$DRY" = "1" ] && [ ! -e "$INSTALL_DIR/docker-compose.yml" ]; then
    printf 'services: {}\n' > "$INSTALL_DIR/docker-compose.yml"
  fi
}

ask_password() {
  local p1 p2
  if [ -n "${BRAIN_PASSWORD:-}" ]; then p1="$BRAIN_PASSWORD"; else
    printf 'Choose the Brain password: '; read -rs p1 <&3 || no_terminal; printf '\n'
    printf 'Once more: '; read -rs p2 <&3 || no_terminal; printf '\n'
    [ "$p1" = "$p2" ] || die "Password: the two entries differ."
  fi
  [ "${#p1}" -ge 8 ] || die "Password: at least 8 characters."
  # The password reaches the image on stdin only. It is never an argument and
  # never in the log, so this call is real under dry run as well.
  HASH="$(printf '%s\n' "$p1" | docker run --rm -i "ghcr.io/michaelbrowk/brain:$TAG" hash-password)" || HASH=""
  [ -n "$HASH" ] || die "Could not hash the password with the Brain image."
}

ask_domain() {
  local domain
  # Set but empty means no domain and no question, so a scripted install can
  # say so without a terminal.
  if [ -n "${BRAIN_DOMAIN+set}" ]; then domain="$BRAIN_DOMAIN"; else
    printf 'Domain name for this Brain, or leave empty to keep it on this machine only: '
    read -r domain <&3 || no_terminal
  fi
  if [ -n "$domain" ]; then ORIGIN="https://$domain"; else ORIGIN="http://localhost:3020"; fi
}

# .env is written for real under dry run too, like the directories above: it
# is the plan's output, and the tests read it. Only apt, Docker, systemctl and
# the compose download pass through run.
#
# Compose reads .env itself and treats "$" as interpolation, so each "$" in
# the bcrypt hash is doubled, exactly as README.md says for the manual path.
# The umask lives in a subshell so that only this file comes out as 600.
write_env() {
  local escaped; escaped="$(printf '%s' "$HASH" | sed 's/\$/$$/g')"
  # Made before the file is opened, so a failing openssl stops the run under
  # set -e instead of leaving an empty AUTH_SECRET behind.
  local secret; secret="$(openssl rand -hex 32)"
  (
    umask 077
    cat > "$INSTALL_DIR/.env" <<EOF
NOTES_ROOT=$NOTES_DIR
AUTH_SECRET=$secret
AUTH_PASSWORD_HASH=$escaped
BRAIN_PUBLIC_ORIGIN=$ORIGIN
EOF
  )
  # The umask shapes a new file only. A .env that already existed keeps its
  # old mode through the rewrite, so tighten it either way.
  chmod 600 "$INSTALL_DIR/.env"
}

# For a Brain without a domain: how to reach it from another computer. Printed
# last, so it moves behind the run and verify steps once those land.
local_access_hint() {
  [ "$ORIGIN" = "http://localhost:3020" ] || return 0
  say "No domain, so Brain listens on this machine only. To open it from your computer:"
  say "  ssh -L 3020:127.0.0.1:3020 ${SUDO_USER:-root}@$(hostname)"
  say "  then browse to http://localhost:3020"
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
  ensure_docker
  resolve_release
  layout
  ask_password
  ask_domain
  write_env
  local_access_hint
  say "install.sh: skeleton"    # replaced task by task
}
main "$@"
