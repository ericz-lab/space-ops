#!/usr/bin/env bash
# Run from the source checkout, after access policy verification and local checks.
set -euo pipefail
TARGET=${1:?Usage: bash deploy/bootstrap.sh ssh-host [loopback]}
PRIVATE=0
if [[ "${2:-}" == loopback ]]; then PRIVATE=1; fi
bun run check
ssh -o BatchMode=yes -o ConnectTimeout=10 "$TARGET" "bash -s -- $PRIVATE" <<'REMOTE'
set -euo pipefail
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
WS=${SPACE_HOME:-$HOME/.ai-space}
if [[ ! -d "$HOME/space-ops.git" ]]; then git init --bare --initial-branch=main "$HOME/space-ops.git"; fi
if [[ "$1" == 1 ]]; then
  cd "$WS"
  # URL overrides are read by the Space process at boot, not by app sync.
  bun -e 'const r=await fetch("http://127.0.0.1:8700/api/tasks");const d=await r.json();if(!r.ok||!Array.isArray(d.tasks)||d.tasks.some(t=>t.state?.runningAt)){throw new Error("Wait for active Space tasks before applying the private URL override");}'
  bun -e 'const file=Bun.file(".env");let text=await file.text();const line="SPACE_APP_URL_SPACE_OPS=http://127.0.0.1:8998";text=/^SPACE_APP_URL_SPACE_OPS=.*$/m.test(text)?text.replace(/^SPACE_APP_URL_SPACE_OPS=.*$/m,line):text.replace(/\s*$/, "\n")+line+"\n";await Bun.write(".env",text);'
  systemctl --user restart ai-space
  for attempt in $(seq 1 15); do
    if curl -fsS --max-time 2 http://127.0.0.1:8700/healthz >/dev/null; then break; fi
    sleep 1
  done
  curl -fsS --max-time 5 http://127.0.0.1:8700/healthz >/dev/null
fi
REMOTE
ssh -o BatchMode=yes "$TARGET" 'cat > "$HOME/space-ops.git/hooks/post-receive" && chmod +x "$HOME/space-ops.git/hooks/post-receive"' < deploy/post-receive
git push "$TARGET:space-ops.git" main
