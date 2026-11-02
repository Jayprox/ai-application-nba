#!/bin/zsh -l
# Thin launchd wrapper for scripts/backup-db.mjs (ops/launchd/README.md).
# All logging is done by the script itself (BACKUP_LOG).
cd "${0:A:h}/.." || exit 1
exec node scripts/backup-db.mjs
