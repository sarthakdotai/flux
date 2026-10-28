#!/bin/zsh
# Pushes this folder's code to the server in config.env and restarts Flux there.
# Credentials (/opt/flux/.env) and push keys/subscriptions (/opt/flux/data) stay on the server.
set -e
cd "${0:A:h}"

[[ -f config.env ]] || { echo "Missing config.env: copy config.example.env and fill it in." >&2; exit 1; }
source ./config.env
SSH="ssh -i ${FLUX_SSH_KEY/#\~/$HOME} -o BatchMode=yes"

rsync -az --delete --exclude node_modules --exclude data --exclude .claude --exclude design --exclude .env \
  --exclude .git --exclude config.env --exclude mac -e "$SSH" ./ "$FLUX_HOST:/opt/flux/"
${=SSH} "$FLUX_HOST" 'cd /opt/flux && PATH=/opt/node/bin:$PATH npm ci --omit=dev --silent && sudo systemctl restart flux && sleep 3 && systemctl is-active flux'
