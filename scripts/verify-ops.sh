#!/usr/bin/env bash
# The operational gate both workflows run: shell syntax, systemd units,
# sysusers/tmpfiles/ACL contract, Mail runtime ownership, Mail key creation,
# and the reference nginx vhost.
# Linux only; needs sudo, systemd-analyze, shellcheck, acl, python3, nginx,
# openssl.
set -Eeuo pipefail

ok() { echo "verify-ops: $1 ok"; }

verify_scripts() {
bash -n \
  scripts/deploy-release.sh \
  scripts/verify-ops.sh \
  ops/brain-alert.sh \
  scripts/smoke-backup.sh \
  ops/backup-notes.sh \
  ops/deploy-puller.sh \
  ops/create-brain-mail-key.sh \
  ops/install-brain-mail.sh \
  ops/rollback-brain-mail-install.sh \
  ops/install-deploy-puller.sh \
  ops/install-node-runtime.sh \
  ops/docker/brain-entrypoint.sh \
  install.sh
shellcheck \
  scripts/verify-ops.sh \
  scripts/deploy-release.sh \
  ops/brain-alert.sh \
  scripts/smoke-backup.sh \
  ops/backup-notes.sh \
  ops/deploy-puller.sh \
  ops/create-brain-mail-key.sh \
  ops/install-brain-mail.sh \
  ops/rollback-brain-mail-install.sh \
  ops/install-deploy-puller.sh \
  ops/install-node-runtime.sh \
  ops/docker/brain-entrypoint.sh \
  install.sh
ok scripts
}

verify_deploy_puller_units() {
local verify_dir
verify_dir="$(mktemp -d)"
trap 'rm -rf "$verify_dir"' RETURN
cp \
  ops/brain-deploy-puller.service \
  ops/brain-deploy-puller.timer \
  'ops/brain-alert@.service' \
  "$verify_dir/"
sed -i \
  's#^ExecStart=/opt/brain/bin/deploy-puller.sh$#ExecStart=/usr/bin/true#' \
  "$verify_dir/brain-deploy-puller.service"
sed -i \
  's#^ExecStart=/opt/brain/bin/brain-alert.sh %i$#ExecStart=/usr/bin/true#' \
  "$verify_dir/brain-alert@.service"
cat > "$verify_dir/brain.service" <<'UNIT'
[Service]
Type=oneshot
ExecStart=/usr/bin/true
UNIT
SYSTEMD_UNIT_PATH="$verify_dir:/etc/systemd/system:/run/systemd/system:/usr/local/lib/systemd/system:/usr/lib/systemd/system:/lib/systemd/system" \
  systemd-analyze verify \
    "$verify_dir/brain-deploy-puller.service" \
    "$verify_dir/brain-deploy-puller.timer"
schedule="$(sed -n 's/^OnCalendar=//p' \
  "$verify_dir/brain-deploy-puller.timer")"
test "$schedule" = '*:0/2'
systemd-analyze calendar "$schedule" --iterations=3
ok deploy-puller-units
}

verify_mail_units() {
local verify_dir
verify_dir="$(mktemp -d)"
sudo install -d -m 0755 /run/brain-mail-runtime
trap 'rm -rf "$verify_dir"; sudo rmdir /run/brain-mail-runtime' RETURN
cp \
  ops/brain-mail.service \
  ops/brain-mail.socket \
  ops/brain-mail-mime.socket \
  ops/brain-mail-mime@.service \
  'ops/brain-alert@.service' \
  "$verify_dir/"
sed -i \
  's#^ExecStart=/opt/brain/bin/brain-alert.sh %i$#ExecStart=/usr/bin/true#' \
  "$verify_dir/brain-alert@.service"
sed -i \
  -e 's/^User=brain-mail$/User=root/' \
  -e 's/^Group=brain-mail$/Group=root/' \
  -e '/^SupplementaryGroups=brain-mail-runtime$/d' \
  -e 's#^ExecStart=/opt/brain/runtime/current/bin/node .*#ExecStart=/usr/bin/true#' \
  "$verify_dir/brain-mail.service"
sed -i 's/^SocketGroup=brain-mail-client$/SocketGroup=root/' \
  "$verify_dir/brain-mail.socket"
sed -i \
  -e 's/^User=brain-mail-mime$/User=root/' \
  -e 's/^Group=brain-mail-mime$/Group=root/' \
  -e '/^SupplementaryGroups=brain-mail-runtime$/d' \
  -e 's#^ExecStart=/opt/brain/runtime/current/bin/node .*#ExecStart=/usr/bin/true#' \
  "$verify_dir/brain-mail-mime@.service"
sed -i \
  -e 's/^SocketUser=brain-mail$/SocketUser=root/' \
  -e 's/^SocketGroup=brain-mail$/SocketGroup=root/' \
  "$verify_dir/brain-mail-mime.socket"
grep --fixed-strings --line-regexp \
  "Requires=brain-mail.socket brain-mail-mime.socket" \
  "$verify_dir/brain-mail.service"
grep --fixed-strings --line-regexp \
  "After=brain-mail.socket brain-mail-mime.socket" \
  "$verify_dir/brain-mail.service"
test "$(grep --count '^Sockets=' "$verify_dir/brain-mail.service")" = 1
grep --fixed-strings --line-regexp "Sockets=brain-mail.socket" \
  "$verify_dir/brain-mail.service"
SYSTEMD_UNIT_PATH="$verify_dir:/etc/systemd/system:/run/systemd/system:/usr/local/lib/systemd/system:/usr/lib/systemd/system:/lib/systemd/system" \
  systemd-analyze verify \
    "$verify_dir/brain-mail.socket" \
    "$verify_dir/brain-mail.service" \
    "$verify_dir/brain-mail-mime.socket" \
    "$verify_dir/brain-mail-mime@.service"
ok mail-units
}

verify_mail_accounts() {
local sandbox
sandbox="$(mktemp -d)"
trap 'sudo rm -rf "$sandbox"' RETURN
sudo chown root:root "$sandbox"
sudo chmod 0755 "$sandbox"
sudo install -d -m 0755 \
  "$sandbox/etc" \
  "$sandbox/opt/brain" \
  "$sandbox/usr/lib/sysusers.d" \
  "$sandbox/usr/lib/tmpfiles.d"
sudo install -m 0644 ops/brain-mail.sysusers.conf \
  "$sandbox/usr/lib/sysusers.d/brain-mail.conf"
sudo install -m 0644 ops/brain-mail-mime.sysusers.conf \
  "$sandbox/usr/lib/sysusers.d/brain-mail-mime.conf"
sudo install -m 0644 ops/brain-mail.tmpfiles.conf \
  "$sandbox/usr/lib/tmpfiles.d/brain-mail.conf"
sudo install -m 0644 ops/brain-mail-mime.tmpfiles.conf \
  "$sandbox/usr/lib/tmpfiles.d/brain-mail-mime.conf"
sudo systemd-sysusers --root="$sandbox"
mail_client_gid="$(awk -F: '$1 == "brain-mail-client" { print $3 }' "$sandbox/etc/group")"
runtime_gid="$(awk -F: '$1 == "brain-mail-runtime" { print $3 }' "$sandbox/etc/group")"
brain_gid="$(awk -F: '$1 == "brain-mail" { print $3 }' "$sandbox/etc/group")"
mime_uid="$(awk -F: '$1 == "brain-mail-mime" { print $3 }' "$sandbox/etc/passwd")"
test -n "$mail_client_gid"
test -n "$runtime_gid"
test -n "$brain_gid"
test -n "$mime_uid"
# libacl resolves ACL names through host NSS even when tmpfiles uses --root.
# Keep the production ACL named, but use the sandbox's generated GID here.
sudo sed -i "s/g:brain-mail-runtime:--x/g:$runtime_gid:--x/" \
  "$sandbox/usr/lib/tmpfiles.d/brain-mail.conf"
sudo systemd-tmpfiles --create --root="$sandbox"
test "$(stat -c '%a:%u:%g' "$sandbox/run/brain-mail")" = "710:0:$mail_client_gid"
test "$(stat -c '%a:%u:%g' "$sandbox/run/brain-mail-mime")" = "710:0:$brain_gid"
test "$(stat -c '%a:%u:%g' "$sandbox/run/brain-mail-runtime")" = "550:0:$runtime_gid"
sudo getfacl --absolute-names --numeric "$sandbox/opt/brain"
sudo getfacl --omit-header --numeric "$sandbox/opt/brain" \
  | grep --fixed-strings --line-regexp "group:$runtime_gid:--x"
ok mail-accounts
}

verify_mail_runtime_ownership() {
sudo env PYTHONDONTWRITEBYTECODE=1 python3 ops/project_mail_runtime_test.py
ok mail-runtime-ownership
}

verify_mail_key() {
sudo env PYTHONDONTWRITEBYTECODE=1 python3 ops/create_brain_mail_key_test.py
ok mail-key
}

verify_nginx_reference() {
  local sandbox
  sandbox="$(mktemp -d)"
  trap 'rm -rf "$sandbox"' RETURN
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=brain.example.com" \
    -keyout "$sandbox/privkey.pem" -out "$sandbox/fullchain.pem" 2>/dev/null
  # The two :80 listeners move to an unprivileged port nothing else wants.
  # `nginx -t` really opens its listen sockets, and the runner installs the
  # distribution nginx, whose default site already holds 0.0.0.0:80 — so
  # testing the file as written would fail on a bind, not on the config.
  sed \
    -e "s#/etc/letsencrypt/live/brain.example.com/fullchain.pem#$sandbox/fullchain.pem#" \
    -e "s#/etc/letsencrypt/live/brain.example.com/privkey.pem#$sandbox/privkey.pem#" \
    -e "s#/etc/nginx/brain-edge-secret.conf#$sandbox/brain-edge-secret.conf#" \
    -e "s#/etc/nginx/brain-cloudflare-ips.conf#$sandbox/brain-cloudflare-ips.conf#" \
    -e "s#^    listen 80;#    listen 18080;#" \
    -e "s#^    listen \[::\]:80;#    listen [::]:18080;#" \
    ops/nginx/brain.conf.example > "$sandbox/brain.conf"
  cp ops/nginx/brain-edge-secret.conf.example "$sandbox/brain-edge-secret.conf"
  cp ops/nginx/brain-cloudflare-ips.conf.example "$sandbox/brain-cloudflare-ips.conf"
  printf 'pid %s/nginx.pid;\nerror_log %s/error.log;\nevents {}\nhttp {\n  access_log off;\n  include %s/brain.conf;\n}\n' \
    "$sandbox" "$sandbox" "$sandbox" > "$sandbox/nginx.conf"
  # -t still opens the listen sockets, and 443 is privileged: on the runner
  # the gate runs as the runner user, so the bind needs the same sudo every
  # other block already leans on.
  sudo nginx -t -q -c "$sandbox/nginx.conf" -p "$sandbox"
  ok nginx-reference
}

verify_scripts
verify_deploy_puller_units
bash scripts/smoke-backup.sh
verify_mail_units
verify_mail_accounts
verify_mail_runtime_ownership
verify_mail_key
verify_nginx_reference
