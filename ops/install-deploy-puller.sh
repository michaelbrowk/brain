#!/usr/bin/env bash
set -Eeuo pipefail

if (( EUID != 0 )); then
  echo "run as root" >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
bin_dir=/opt/brain/bin
unit_dir=/etc/systemd/system

for command in \
  curl flock getent groupadd id openssl passwd pgrep python3 setfacl stat \
  systemctl systemd-run useradd usermod; do
  command -v "$command" >/dev/null || {
    echo "$command is required before installing the Brain deploy puller" >&2
    exit 1
  }
done

getent group brain >/dev/null || {
  echo "the existing brain service group is missing" >&2
  exit 1
}
brain_uid="$(id -u brain)" || {
  echo "the existing brain service user is missing" >&2
  exit 1
}
read -r -a brain_sensitive_gids <<<"$(id -G brain)"
if [[ ! "$brain_uid" =~ ^[0-9]+$ || "$brain_uid" == "0" || \
  "${#brain_sensitive_gids[@]}" == "0" ]]; then
  echo "the brain service identity must be unprivileged and have numeric groups" >&2
  exit 1
fi
for sensitive_gid in "${brain_sensitive_gids[@]}"; do
  if [[ ! "$sensitive_gid" =~ ^[0-9]+$ ]]; then
    echo "the brain service group list is malformed" >&2
    exit 1
  fi
done

assert_trusted_directory() {
  local trusted_dir="$1"
  local trusted_mode
  if [[ ! -d "$trusted_dir" || -L "$trusted_dir" || \
    "$(stat -c '%u' "$trusted_dir")" != "0" ]]; then
    echo "$trusted_dir must be an existing root-owned real directory" >&2
    exit 1
  fi
  trusted_mode="$(stat -c '%a' "$trusted_dir")"
  if (( (8#$trusted_mode & 0022) != 0 )); then
    echo "$trusted_dir must not be group- or world-writable" >&2
    exit 1
  fi
}

assert_safe_destination() {
  local destination="$1"
  local destination_mode
  if [[ ! -e "$destination" && ! -L "$destination" ]]; then
    return
  fi
  if [[ ! -f "$destination" || -L "$destination" || \
    "$(stat -c '%u' "$destination")" != "0" ]]; then
    echo "$destination must be absent or a root-owned regular file" >&2
    exit 1
  fi
  destination_mode="$(stat -c '%a' "$destination")"
  if (( (8#$destination_mode & 0022) != 0 )); then
    echo "$destination must not be group- or world-writable" >&2
    exit 1
  fi
}

if [[ ! -d /opt/brain || -L /opt/brain || "$(stat -c '%u' /opt/brain)" != "0" ]]; then
  echo "/opt/brain must be an existing root-owned directory" >&2
  exit 1
fi
for trusted_dir in / /etc /etc/brain /etc/systemd/system /opt /opt/brain; do
  assert_trusted_directory "$trusted_dir"
done
for managed_dir in "$bin_dir" /opt/brain/incoming /opt/brain/releases; do
  if [[ -e "$managed_dir" || -L "$managed_dir" ]]; then
    assert_trusted_directory "$managed_dir"
  fi
done
exec 8>/opt/brain/.deploy-poll.lock
if ! flock -n 8; then
  echo "another Brain deploy poll is running" >&2
  exit 1
fi
exec 9>/opt/brain/.deploy.lock
if ! flock -n 9; then
  echo "another Brain deployment is running" >&2
  exit 1
fi
if [[ -e /opt/brain/.deploy-transaction.json || \
  -L /opt/brain/.deploy-transaction.json || \
  -e /opt/brain/.deploy-pending.json || \
  -L /opt/brain/.deploy-pending.json ]]; then
  echo "recover the pending Brain deployment transaction before installing" >&2
  exit 1
fi

if systemctl is-active --quiet brain-deploy-puller.service || \
  systemctl is-active --quiet brain-deploy-puller.timer; then
  echo "stop the Brain deploy puller service and timer before installing" >&2
  exit 1
fi
if systemctl is-enabled --quiet brain-deploy-puller.timer; then
  echo "disable the Brain deploy puller timer before installing" >&2
  exit 1
fi

getent group brain-deploy >/dev/null || groupadd --system brain-deploy
brain_deploy_gid="$(getent group brain-deploy | cut -d: -f3)"
if [[ ! "$brain_deploy_gid" =~ ^[0-9]+$ || "$brain_deploy_gid" == "0" ]]; then
  echo "brain-deploy group must be unprivileged" >&2
  exit 1
fi
for sensitive_gid in "${brain_sensitive_gids[@]}"; do
  if [[ "$brain_deploy_gid" == "$sensitive_gid" ]]; then
    echo "brain-deploy primary group must be numerically distinct from every brain group" >&2
    exit 1
  fi
done
if ! id -u brain-deploy >/dev/null 2>&1; then
  useradd \
    --system \
    --gid brain-deploy \
    --home-dir /nonexistent \
    --no-create-home \
    --shell /usr/sbin/nologin \
    brain-deploy
fi
if [[ "$(id -u brain-deploy)" == "0" ]]; then
  echo "brain-deploy must be unprivileged" >&2
  exit 1
fi
brain_deploy_uid="$(id -u brain-deploy)"
if [[ "$brain_deploy_uid" == "$brain_uid" ]]; then
  echo "brain-deploy must have a distinct numeric uid from brain" >&2
  exit 1
fi
if pgrep -u "$(id -u brain-deploy)" >/dev/null; then
  echo "brain-deploy must not have running processes during installation" >&2
  exit 1
fi
usermod \
  --gid brain-deploy \
  --groups '' \
  --home /nonexistent \
  --shell /usr/sbin/nologin \
  brain-deploy
passwd --lock brain-deploy >/dev/null

IFS=: read -r account_name _ account_uid account_gid _ account_home account_shell < <(
  getent passwd brain-deploy
)
if [[ "$account_name" != "brain-deploy" || "$account_uid" == "0" || \
  "$brain_deploy_gid" == "0" || \
  "$account_gid" != "$brain_deploy_gid" || "$account_home" != "/nonexistent" || \
  "$account_shell" != "/usr/sbin/nologin" ]]; then
  echo "brain-deploy account does not match the locked service identity" >&2
  exit 1
fi
if [[ "$(id -G brain-deploy)" != "$brain_deploy_gid" ]]; then
  echo "brain-deploy must not have supplementary groups" >&2
  exit 1
fi
password_state="$(passwd -S brain-deploy | awk '{print $2}')"
if [[ "$password_state" != "L" && "$password_state" != "LK" ]]; then
  echo "brain-deploy password must be locked" >&2
  exit 1
fi
if [[ -e /nonexistent || -L /nonexistent ]]; then
  echo "/nonexistent must not exist" >&2
  exit 1
fi

install -d -o root -g root -m 0755 "$bin_dir"
install -d -o root -g brain -m 0750 /opt/brain/incoming /opt/brain/releases
for trusted_dir in \
  / /etc /etc/brain /etc/systemd/system /opt /opt/brain \
  "$bin_dir" /opt/brain/incoming /opt/brain/releases; do
  assert_trusted_directory "$trusted_dir"
done
for destination in \
  "$bin_dir/deploy-puller.sh" \
  "$bin_dir/resolve-deploy-candidate.mjs" \
  "$bin_dir/deploy-provenance.mjs" \
  "$bin_dir/deploy-transaction.mjs" \
  "$bin_dir/read-mail-health-commit.mjs" \
  "$bin_dir/extract_release.py" \
  "$bin_dir/write-release-metadata.mjs" \
  "$unit_dir/brain-deploy-puller.service" \
  "$unit_dir/brain-deploy-puller.timer"; do
  assert_safe_destination "$destination"
done
setfacl -m u:brain-deploy:--x /opt/brain /opt/brain/incoming
install -o root -g root -m 0755 \
  "$repo_root/ops/deploy-puller.sh" \
  "$bin_dir/deploy-puller.sh"
install -o root -g root -m 0755 \
  "$repo_root/ops/resolve-deploy-candidate.mjs" \
  "$bin_dir/resolve-deploy-candidate.mjs"
install -o root -g root -m 0644 \
  "$repo_root/ops/deploy-provenance.mjs" \
  "$bin_dir/deploy-provenance.mjs"
install -o root -g root -m 0755 \
  "$repo_root/ops/deploy-transaction.mjs" \
  "$bin_dir/deploy-transaction.mjs"
install -o root -g root -m 0644 \
  "$repo_root/ops/read-mail-health-commit.mjs" \
  "$bin_dir/read-mail-health-commit.mjs"
install -o root -g root -m 0755 \
  "$repo_root/ops/extract_release.py" \
  "$bin_dir/extract_release.py"
install -o root -g root -m 0644 \
  "$repo_root/scripts/write-release-metadata.mjs" \
  "$bin_dir/write-release-metadata.mjs"
install -o root -g root -m 0644 \
  "$repo_root/ops/brain-deploy-puller.service" \
  "$unit_dir/brain-deploy-puller.service"
install -o root -g root -m 0644 \
  "$repo_root/ops/brain-deploy-puller.timer" \
  "$unit_dir/brain-deploy-puller.timer"

systemctl daemon-reload
echo "installed but not enabled: configure /etc/brain/deployer.env, then run a manual dry-run"
