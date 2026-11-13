#!/usr/bin/env bash
# Gera e publica a lista a partir de uma máquina no Brasil.
# Uso: RESOLVER_BASE_URL=https://seu-worker.workers.dev ./scripts/atualizar-local.sh
# Agende com cron (a cada 6 h):  0 */6 * * * cd /caminho/repo && RESOLVER_BASE_URL=... ./scripts/atualizar-local.sh
set -euo pipefail
cd "$(dirname "$0")/.."
: "${RESOLVER_BASE_URL:?Defina RESOLVER_BASE_URL}"
git pull --rebase --autostash
npm test
npm run build
npm run verify -- --sample=30
git add playlist data
git diff --cached --quiet || git commit -m "chore: atualiza lista (local, $(date -u +'%Y-%m-%d %H:%M UTC'))"
git push
