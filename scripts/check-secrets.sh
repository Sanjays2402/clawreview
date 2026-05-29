#!/usr/bin/env bash
set -euo pipefail
PATTERNS='AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36,}|-----BEGIN [A-Z ]*PRIVATE KEY-----'
if git ls-files | grep -v '/fixtures/' | xargs grep -EIn "$PATTERNS" 2>/dev/null; then
  echo "Possible secret committed."
  exit 1
fi
echo "OK: no obvious secrets."
