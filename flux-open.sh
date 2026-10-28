#!/bin/zsh
# Opens Flux running on the server in config.env: starts a private SSH tunnel to its
# 127.0.0.1:3030 (if one isn't already up) and opens http://localhost:3030 in the browser.
# The server is never exposed to the internet; the tunnel is the only way in.
set -e
cd "${0:A:h}"

[[ -f config.env ]] || { echo "Missing config.env: copy config.example.env and fill it in." >&2; exit 1; }
source ./config.env
KEY=${FLUX_SSH_KEY/#\~/$HOME}
PORT=3030

if lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  if pgrep -f "ssh .*-L $PORT:127.0.0.1:$PORT" >/dev/null; then
    echo "Tunnel already open."
  else
    echo "Port $PORT is in use by something else (a local 'npm start'?). Stop it first." >&2
    exit 1
  fi
else
  ssh -i "$KEY" -f -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
    -L $PORT:127.0.0.1:$PORT "$FLUX_HOST"
  echo "Tunnel open."
fi

open "http://localhost:$PORT"
