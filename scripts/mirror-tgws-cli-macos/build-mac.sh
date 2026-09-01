#!/bin/sh
# ============================================================================
#  Local build of the macOS (arm64) headless TgWsProxy CLI for the
#  slipgate-tgws-cli-macos mirror. Mirrors the CI steps in
#  .github/workflows/build.yml so you can reproduce a release asset by hand.
#
#  Usage:
#    ./build-mac.sh                       # clones Flowseal/tg-ws-proxy @ latest
#    UPSTREAM_TAG=v1.10.0 ./build-mac.sh  # clones a specific tag
#    PROXY_DIR=/path/to/tg-ws-proxy ./build-mac.sh   # use an existing checkout
#
#  Output: dist/TgWsProxy  (bare arm64 Mach-O, no extension)
# ============================================================================
set -eu

ROOT="$(cd "$(dirname "$0")" && pwd)"
OUT="$ROOT/dist"
UPSTREAM_TAG="${UPSTREAM_TAG:-latest}"
PROXY_DIR="${PROXY_DIR:-$ROOT/upstream}"

if [ ! -d "$PROXY_DIR" ]; then
  echo "[*] cloning Flowseal/tg-ws-proxy ($UPSTREAM_TAG)"
  if [ "$UPSTREAM_TAG" = "latest" ]; then
    git clone --depth 1 https://github.com/Flowseal/tg-ws-proxy.git "$PROXY_DIR"
  else
    git clone --depth 1 --branch "$UPSTREAM_TAG" https://github.com/Flowseal/tg-ws-proxy.git "$PROXY_DIR"
  fi
fi

cd "$PROXY_DIR"

python3 -m venv .venv
# shellcheck disable=SC1091
. .venv/bin/activate

pip install --upgrade pip pyinstaller certifi

python - <<'PY'
import tomllib, re
deps = []
try:
  with open('pyproject.toml', 'rb') as f:
    d = tomllib.load(f)
  deps = [x for x in d.get('project', {}).get('dependencies', [])
          if not re.match(r'^(pystray|customtkinter|pillow|pyperclip|pyobjc|pyobjc-framework)', x, re.I)]
except FileNotFoundError:
  try:
    deps = [l for l in open('requirements.txt') if l.strip() and not l.startswith('#')
            and not re.match(r'^(pystray|customtkinter|pillow|pyperclip|pyobjc|pyobjc-framework)', l, re.I)]
  except FileNotFoundError:
    deps = []
open('req-cli.txt', 'w').write('\n'.join(deps))
PY

pip install -r req-cli.txt

cat > _cli.py <<'PY'
from proxy.tg_ws_proxy import main
if __name__ == '__main__':
    main()
PY

mkdir -p "$OUT"
pyinstaller --onefile --console --name TgWsProxy \
  --target-arch arm64 --distpath "$OUT" \
  --collect-all certifi \
  --hidden-import proxy --hidden-import proxy.tg_ws_proxy --hidden-import proxy.bridge \
  --hidden-import proxy.config --hidden-import proxy.balancer --hidden-import proxy.fake_tls \
  --hidden-import proxy.raw_websocket --hidden-import proxy.stats --hidden-import proxy.utils \
  --hidden-import utils.logging_setup \
  --exclude-module pystray --exclude-module customtkinter --exclude-module PIL \
  --exclude-module tkinter --exclude-module macos --exclude-module windows --exclude-module linux \
  _cli.py

chmod +x "$OUT/TgWsProxy"
echo "[OK] built: $OUT/TgWsProxy"
file "$OUT/TgWsProxy"
"$OUT/TgWsProxy" --help >/dev/null 2>&1 && echo "[OK] smoke test passed" || echo "[WARN] smoke test failed"
