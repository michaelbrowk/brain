# syntax=docker/dockerfile:1.7
# Build context is the repository root; the stage is produced by
# `node scripts/build-release.mjs --layout release --stage .next/release-stage`.
FROM node:22.23.1-bookworm-slim
# Paired with .dockerignore, which admits only .next/release-stage/** into the
# context; overriding BRAIN_STAGE without widening .dockerignore copies an
# empty tree.
ARG BRAIN_STAGE=.next/release-stage
RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/* \
  && install -d -o node -g node -m 0700 /opt/brain/notes /var/lib/brain /var/lib/brain-mail /run/credentials/brain-mail \
  && install -d -o node -g node -m 0710 /run/brain-mail \
  && install -d -o root -g root -m 0755 /opt/brain/bin /opt/brain/current
COPY --chown=root:root ${BRAIN_STAGE}/ /opt/brain/current/
COPY --chown=root:root ops/docker/brain-entrypoint.sh ops/docker/brain-mail-activate.mjs ops/docker/brain-hash-password.mjs /opt/brain/bin/
RUN chmod 0755 /opt/brain/bin/brain-entrypoint.sh \
  && test "$(node --version)" = "v22.23.1" \
  && rg --version >/dev/null \
  && git --version >/dev/null \
  && test -f /opt/brain/current/release.json \
  && test -z "$(find /opt/brain/current -name '*.node' -print -quit)"
USER node
WORKDIR /opt/brain/current
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3020 \
    NOTES_ROOT=/opt/brain/notes \
    BRAIN_OAUTH_STATE_DIR=/var/lib/brain/oauth \
    BRAIN_MAIL_SOCKET_PATH=/run/brain-mail/brain-mail.sock
EXPOSE 3020
ENTRYPOINT ["/opt/brain/bin/brain-entrypoint.sh"]
CMD ["web"]
