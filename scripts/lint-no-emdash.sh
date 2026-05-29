#!/usr/bin/env bash
set -euo pipefail
if grep -RIn --include='*.md' --include='*.tsx' --include='*.ts' '\xE2\x80\x94' . | grep -v node_modules | grep -v .git ; then
  echo "Found em-dashes. Replace with two hyphens, a comma, or a sentence break."
  exit 1
fi
echo "OK: no em-dashes."
