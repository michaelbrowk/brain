#!/usr/bin/env bash
# One-command install of Brain on Ubuntu.
#   curl -fsSL https://raw.githubusercontent.com/michaelbrowk/brain/main/install.sh | sudo bash
# Re-running it upgrades. `--uninstall` removes everything except the notes.
set -euo pipefail

DRY="${BRAIN_INSTALL_DRY_RUN:-0}"
INSTALL_DIR="${BRAIN_INSTALL_DIR:-/opt/brain}"
RELEASES_API="${BRAIN_RELEASES_API:-https://api.github.com/repos/michaelbrowk/brain/releases/latest}"
RAW="https://raw.githubusercontent.com/michaelbrowk/brain"
CADDYFILE="${BRAIN_CADDYFILE:-/etc/caddy/Caddyfile}"
# The first line of the site file this script writes. Only a file that
# starts with it is replaced or removed; anyone else's is left alone, even
# one with the script's block added by hand.
CADDY_MARK="# managed by Brain install.sh"
OS_RELEASE="${BRAIN_OS_RELEASE:-/etc/os-release}"
# This machine's public address, once asked for. Empty until then, and empty
# when no service would say.
PUBLIC=""

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

require_root() { [ "$(id -u)" = "0" ] || die "Run this with sudo: it installs Docker and needs root for that."; }

# Every apt call goes through here, so none can miss the lock timeout: on a
# machine that has just booted, cloud-init's own apt holds the dpkg lock for
# a while, and without the timeout apt dies on it with its raw error. The
# wait is announced once, before the first call, and only when the lock is
# held at that moment and fuser is there to ask (psmisc is not required).
APT_WAIT_ANNOUNCED=0
apt_get() {
  if [ "$APT_WAIT_ANNOUNCED" = 0 ]; then
    APT_WAIT_ANNOUNCED=1
    if command -v fuser >/dev/null && fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; then
      say "Waiting for other package managers to finish, if any..."
    fi
  fi
  run apt-get -o DPkg::Lock::Timeout=300 "$@"
}

# The value of KEY in a KEY=value file (.env, os-release): the first such
# line, without trailing blanks and without the single or double quotes
# around it, which Compose and os-release both allow. Empty when absent.
file_value() {
  local value
  value="$(sed -n "/^$2=/{s/^$2=//p;q;}" "$1")"
  value="${value%"${value##*[![:space:]]}"}"
  case "$value" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
  esac
  printf '%s' "$value"
}

# The systemd install of Brain (docs/operations.md) lives in the same
# directory and on the same port. Checked before either path touches anything.
refuse_systemd_layout() {
  local entry
  for entry in "$INSTALL_DIR/current" "$INSTALL_DIR/releases"; do
    if [ -e "$entry" ] || [ -L "$entry" ]; then
      die "$INSTALL_DIR already holds a systemd install of Brain, with current/ and releases/ in it. This installer manages only its own Docker install and would overwrite that one. Move it, or point BRAIN_INSTALL_DIR somewhere else."
    fi
  done
}

preflight() {
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
  command -v curl >/dev/null || apt_get install -y curl
  command -v openssl >/dev/null || apt_get install -y openssl
}

# Docker's own apt repository, the one for this distribution: Ubuntu and its
# derivatives take the Ubuntu one under the Ubuntu codename, Debian and its
# derivatives the Debian one. ID and ID_LIKE in os-release tell them apart.
ensure_docker() {
  if docker compose version >/dev/null 2>&1; then say "Docker: present"; return; fi
  [ -r "$OS_RELEASE" ] || die "Could not read $OS_RELEASE to pick Docker's apt repository."
  local id like distro codename="" arch
  id="$(file_value "$OS_RELEASE" ID)"; like="$(file_value "$OS_RELEASE" ID_LIKE)"
  case " $id $like " in
    *" ubuntu "*) distro=ubuntu; codename="$(file_value "$OS_RELEASE" UBUNTU_CODENAME)" ;;
    *" debian "*) distro=debian ;;
    *) die "Docker's apt repository covers Ubuntu and Debian; this machine reports ID=${id:-unknown} in $OS_RELEASE." ;;
  esac
  [ -n "$codename" ] || codename="$(file_value "$OS_RELEASE" VERSION_CODENAME)"
  [ -n "$codename" ] || die "Could not read a release codename from $OS_RELEASE to pick Docker's apt repository."
  # preflight has already limited the machine to these two.
  case "$(uname -m)" in x86_64) arch=amd64 ;; *) arch=arm64 ;; esac
  say "Docker: installing from Docker's apt repository for $distro $codename (this replaces the distribution's docker.io package if it is present)"
  apt_get update
  apt_get install -y ca-certificates curl gnupg
  run install -m 0755 -d /etc/apt/keyrings
  run curl -fsSL "https://download.docker.com/linux/$distro/gpg" -o /etc/apt/keyrings/docker.asc
  run chmod a+r /etc/apt/keyrings/docker.asc
  run bash -c "echo 'deb [arch=$arch signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$distro $codename stable' > /etc/apt/sources.list.d/docker.list"
  apt_get update
  apt_get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
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
# and go through run. An upgrade has read the notes path out of .env by now;
# a fresh install gets the default. Every step here is safe to repeat.
layout() {
  NOTES_DIR="${NOTES_DIR:-$INSTALL_DIR/notes}"
  mkdir -p "$INSTALL_DIR" "$NOTES_DIR"
  # The image runs as uid 1000, and Brain refuses a notes folder it cannot write.
  run chown 1000:1000 "$NOTES_DIR"
  # Downloaded next to the compose file and moved into place, so a transfer
  # that drops cannot leave a truncated file where a whole one was.
  local fresh="$INSTALL_DIR/.docker-compose.yml.new"
  run curl -fsSL "$RAW/v$TAG/ops/docker/docker-compose.yml" -o "$fresh" || {
    run rm -f "$fresh"
    die "Could not download the compose file for $TAG. Check the network and try again."
  }
  run mv "$fresh" "$INSTALL_DIR/docker-compose.yml"
  # Under dry run the download above is only announced, so a placeholder
  # stands in and the later steps still have a compose file to read.
  if [ "$DRY" = "1" ] && [ ! -e "$INSTALL_DIR/docker-compose.yml" ]; then
    printf 'services: {}\n' > "$INSTALL_DIR/docker-compose.yml"
  fi
}

ask_password() {
  local p1 p2
  # Read once and dropped, so no later command inherits it.
  if [ -n "${BRAIN_PASSWORD:-}" ]; then p1="$BRAIN_PASSWORD"; unset BRAIN_PASSWORD; else
    printf 'Choose the Brain password: '; read -rs p1 <&3 || no_terminal; printf '\n'
    printf 'Once more: '; read -rs p2 <&3 || no_terminal; printf '\n'
    [ "$p1" = "$p2" ] || die "Password: the two entries differ."
  fi
  [ "${#p1}" -ge 8 ] || die "Password: at least 8 characters."
  # The password reaches the image on stdin only. It is never an argument and
  # never in the log, so this call is real under dry run as well.
  HASH="$(printf '%s\n' "$p1" | docker run --rm -i "ghcr.io/michaelbrowk/brain:$TAG" hash-password)" || HASH=""
  [ -n "$HASH" ] || die "Could not hash the password with the Brain image $TAG. This installer needs a release that ships hash-password; a newer one may be needed."
}

ask_domain() {
  local domain
  # Set but empty means no domain and no question, so a scripted install can
  # say so without a terminal.
  if [ -n "${BRAIN_DOMAIN+set}" ]; then domain="$BRAIN_DOMAIN"; else
    printf 'Domain name for this Brain, or leave empty to keep it on this machine only: '
    read -r domain <&3 || no_terminal
  fi
  if [ -z "$domain" ]; then DOMAIN=""; ORIGIN="http://localhost:3020"; return 0; fi
  # A pasted address is fine: lowercase it, drop the scheme and a trailing
  # slash, then insist on a hostname. Labels of [a-z0-9-], no edge hyphen,
  # at least one dot, 253 characters at most.
  domain="$(printf '%s' "$domain" | tr '[:upper:]' '[:lower:]')"
  domain="${domain#http://}"; domain="${domain#https://}"; domain="${domain%/}"
  local label='[a-z0-9]([a-z0-9-]*[a-z0-9])?'
  if [ "${#domain}" -gt 253 ] || ! [[ $domain =~ ^($label\.)+$label$ ]]; then
    die "Domain: use a bare hostname like notes.example.com."
  fi
  # A last label of digits only is an address, which passes the shape above.
  case "${domain##*.}" in *[!0-9]*) ;; *) die "That is an IP address, not a domain name. Caddy cannot get a certificate for one; leave the answer empty to keep Brain on this machine." ;; esac
  DOMAIN="$domain"; ORIGIN="https://$domain"
}

# Brain publishes 3020, and Caddy needs 80 and 443. Checked before anything
# is installed, so a machine that already runs a web server is left as it
# was. Caddy's own listeners are the expected state on a re-run and pass.
check_ports() {
  command -v ss >/dev/null || { say "Note: ss is not available, skipping the port check."; return 0; }
  local listening ports port line name
  listening="$(ss -ltnp 2>/dev/null || true)"
  ports=(3020); [ -z "$DOMAIN" ] || ports=(80 443 3020)
  for port in "${ports[@]}"; do
    line="$(grep -m 1 -E ":${port}( |\$)" <<< "$listening" || true)"
    [ -n "$line" ] || continue
    name="$(sed -n 's/.*users:(("\([^"]*\)".*/\1/p' <<< "$line")"
    case "$port" in
      3020) die "Port 3020 is already taken by ${name:-another program}. Stop it first, since Brain listens there." ;;
      *) [ "$name" = "caddy" ] && continue
         die "Port $port is already taken by ${name:-another program}. Stop it, or install Brain without a domain and put it behind that proxy yourself." ;;
    esac
  done
}

# Asked once, of a service that echoes the caller's address, with a timeout
# so that a blackholed 443 cannot hold the run. Anything but an address (a
# captive portal page, say) counts as no answer.
public_address() {
  [ -z "$PUBLIC" ] || return 0
  PUBLIC="$(curl -fsSL --connect-timeout 2 --max-time 4 https://api.ipify.org 2>/dev/null || curl -fsSL --connect-timeout 2 --max-time 4 https://ifconfig.me 2>/dev/null)" || true
  case "$PUBLIC" in *[!0-9a-f.:]*) PUBLIC="" ;; esac
}

# A wrong record is not fatal: Caddy keeps asking for the certificate on its
# own, so the install goes on and the sentence names the record to fix.
check_dns() {
  local resolved
  resolved="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1; exit}')" || true
  public_address
  if [ -z "$resolved" ] || [ -z "$PUBLIC" ]; then
    say "Note: could not compare DNS with this machine's address; Caddy keeps retrying until the record points here."
    return 0
  fi
  [ "$resolved" = "$PUBLIC" ] || say "$DOMAIN resolves to $resolved but this machine is $PUBLIC. Point the A record here; Caddy keeps retrying until it can get a certificate."
}

# Caddy's documented apt steps. The Caddyfile in the install directory is the
# plan's output and is written for real; copying it into place and the reload
# are side effects. The caddy package starts the service, so a reload is
# enough on a fresh install as well as on a re-run. A site file that is not
# this script's own would be replaced by the copy, so it is refused first,
# before anything is installed.
caddyfile_is_ours() { [ -f "$CADDYFILE" ] && [ "$(head -n 1 "$CADDYFILE")" = "$CADDY_MARK" ]; }

ensure_caddy() {
  if [ -f "$CADDYFILE" ] && ! caddyfile_is_ours; then
    die "$CADDYFILE already has a site in it. Add $DOMAIN { reverse_proxy 127.0.0.1:3020 } yourself, or install Brain without a domain."
  fi
  if command -v caddy >/dev/null; then say "Caddy: present"; else
    say "Caddy: installing from its apt repository"
    apt_get update
    apt_get install -y debian-keyring debian-archive-keyring apt-transport-https curl
    run bash -c 'curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg'
    run bash -c 'curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list'
    run chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
    apt_get update
    apt_get install -y caddy
  fi
  mkdir -p "$INSTALL_DIR"
  printf '%s\n%s {\n\treverse_proxy 127.0.0.1:3020\n}\n' "$CADDY_MARK" "$DOMAIN" > "$INSTALL_DIR/Caddyfile"
  run install -m 0644 "$INSTALL_DIR/Caddyfile" "$CADDYFILE"
  run systemctl reload caddy
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
}

# Every compose call names the file and the project directory, so it does not
# depend on where the script was started from.
compose() {
  run docker compose -f "$INSTALL_DIR/docker-compose.yml" --project-directory "$INSTALL_DIR" "$@"
}

bring_up() {
  compose pull
  compose up -d
}

# Brain answers on 3020 once its store and search index are ready, which takes
# a moment on the first start. Each probe gives up after 2 s, so a connection
# that stalls instead of being refused cannot eat the budget: 40 probes with a
# second between them come to under two minutes at worst. The probe is a read
# and stays real under dry run; the log tail on failure is a command and goes
# through run.
verify() {
  say "Waiting for Brain to answer on port 3020..."
  local tries=0 body
  while :; do
    if body="$(curl -fsS --max-time 2 http://127.0.0.1:3020/api/health 2>/dev/null)"; then
      VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' <<< "$body")"
      # A release image reports its version. One without is still the tag
      # that was asked for.
      VERSION="${VERSION:-$TAG}"
      return 0
    fi
    tries=$((tries + 1))
    [ "$tries" -lt 40 ] || break
    sleep 1
  done
  compose logs --tail 20 || true
  die "Brain did not answer on port 3020 within two minutes. The last log lines are above; please open an issue with them."
}

finish() {
  say "Brain $VERSION is running."
  say ""
  say "Open:      $ORIGIN"
  say "Notes:     $NOTES_DIR (they belong to the app's user, uid 1000)"
  say "Upgrade:   curl -fsSL $RAW/main/install.sh | sudo bash"
  say "Uninstall: curl -fsSL $RAW/main/install.sh | sudo bash -s -- --uninstall"
  # Without a domain Brain listens on this machine only. The tunnel is how to
  # reach it from another computer, by public address when one can be read.
  [ "$ORIGIN" = "http://localhost:3020" ] || return 0
  public_address
  say "Tunnel:    ssh -L 3020:127.0.0.1:3020 ${SUDO_USER:-root}@${PUBLIC:-$(hostname -f 2>/dev/null || hostname)}"
}

# Takes the containers and their volumes down, removes the Caddy site if it is
# the one this script wrote, then every entry of the install directory except
# the notes directory and every directory that contains it. The notes path
# comes from .env, so notes moved elsewhere inside the directory are spared as
# well, and the default notes directory is spared whatever .env says. The
# comparison is textual: a NOTES_ROOT spelled with a doubled slash, through a
# symlink or as a relative path is not recognised and not protected. Docker
# or Caddy already gone is no reason to stop before the removal and the last
# sentence.
uninstall() {
  local notes=""
  if [ -f "$INSTALL_DIR/.env" ]; then notes="$(file_value "$INSTALL_DIR/.env" NOTES_ROOT)"; fi
  notes="${notes%/}"
  NOTES_DIR="${notes:-$INSTALL_DIR/notes}"
  if [ -f "$INSTALL_DIR/docker-compose.yml" ]; then compose down -v || true; fi
  if caddyfile_is_ours; then
    run rm -f "$CADDYFILE"
    run systemctl reload caddy || true
  fi
  local entry
  for entry in "$INSTALL_DIR"/* "$INSTALL_DIR"/.env "$INSTALL_DIR"/.docker-compose.yml.new; do
    [ -e "$entry" ] || continue
    # The notes directory itself or one of its ancestors, and the default
    # notes directory: a misread .env must not cost the notes.
    case "$NOTES_DIR/" in "$entry"/*) continue ;; esac
    case "$INSTALL_DIR/notes/" in "$entry"/*) continue ;; esac
    run rm -rf -- "$entry"
  done
  if [ -d "$NOTES_DIR" ]; then say "Your notes are still in $NOTES_DIR."; fi
}

main() {
  require_root
  refuse_systemd_layout
  case "${1:-}" in
    "") ;;
    --uninstall) uninstall; exit 0 ;;
    *) die "Unknown option $1. This script takes no arguments, or --uninstall." ;;
  esac
  preflight
  ensure_docker
  resolve_release
  if [ -f "$INSTALL_DIR/.env" ]; then
    say "Existing install found; upgrading to $TAG."
    # The first install answered the questions into .env, which stays as it
    # is apart from its mode: a loose one is tightened.
    ORIGIN="$(file_value "$INSTALL_DIR/.env" BRAIN_PUBLIC_ORIGIN)"
    NOTES_DIR="$(file_value "$INSTALL_DIR/.env" NOTES_ROOT)"; NOTES_DIR="${NOTES_DIR%/}"
    chmod 600 "$INSTALL_DIR/.env"
    layout
  else
    # Questions and checks first, so a run that stops at one of them leaves
    # an existing compose file as it was.
    ask_password
    ask_domain
    check_ports
    if [ -n "$DOMAIN" ]; then check_dns; ensure_caddy; fi
    layout
    write_env
  fi
  bring_up
  verify
  finish
}
main "$@"
