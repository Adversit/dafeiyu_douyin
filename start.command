#!/bin/zsh
cd -- "${0:A:h}" || exit 1
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  print -u2 'Please install Node.js 20.19+, 22.12+, or 24+ with npm, then reopen this launcher.'
  read '?Press Return to close...'
  exit 1
fi
DAFEIYU_PAUSE_ON_ERROR=1 exec node scripts/launch.js
