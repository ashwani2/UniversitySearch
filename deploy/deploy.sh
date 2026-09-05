#!/usr/bin/env bash
#
# Deploy the SOP generator service on the EC2 instance:
#   ssh ec2 'sudo -u flyapp /srv/fly-together-search/deploy/deploy.sh'
#
# No build step — server.js runs directly.

set -euo pipefail

APP_DIR=/srv/fly-together-search
BRANCH=prod

cd "$APP_DIR"

if [[ ! -f .env.production ]]; then
  echo "FATAL: $APP_DIR/.env.production is missing. Copy .env.production.example and fill it in." >&2
  exit 1
fi

echo "==> Fetching $BRANCH"
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git merge --ff-only "origin/$BRANCH"

echo "==> Installing dependencies"
npm ci --omit=dev

echo "==> Restarting service"
sudo systemctl restart fly-together-search

echo "==> Waiting for health check"
for i in {1..15}; do
  if curl -fsS http://127.0.0.1:5001/ >/dev/null 2>&1; then
    echo "==> Healthy. Deployed $(git rev-parse --short HEAD)."
    exit 0
  fi
  sleep 2
done

echo "FATAL: service did not become healthy within 30s." >&2
echo "Check: journalctl -u fly-together-search -n 50 --no-pager" >&2
exit 1
