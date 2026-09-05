#!/bin/sh
# Start the web or the mail process of the Brain container image, or hash a
# login password for the installer.
set -eu

case "${1:-web}" in
  web)
    exec node /opt/brain/current/server.js
    ;;
  mail)
    : "${STATE_DIRECTORY:=/var/lib/brain-mail}"
    : "${CREDENTIALS_DIRECTORY:=/run/credentials/brain-mail}"
    : "${BRAIN_MAIL_SOCKET_PATH:=/run/brain-mail/brain-mail.sock}"
    export STATE_DIRECTORY CREDENTIALS_DIRECTORY
    exec node /opt/brain/bin/brain-mail-activate.mjs \
      "$BRAIN_MAIL_SOCKET_PATH" /opt/brain/current/mail-service/service/main.js
    ;;
  hash-password)
    exec node /opt/brain/bin/brain-hash-password.mjs
    ;;
  *)
    echo "usage: brain-entrypoint.sh web|mail|hash-password" >&2
    exit 64
    ;;
esac
