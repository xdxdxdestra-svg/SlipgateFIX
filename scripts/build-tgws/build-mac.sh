#!/bin/sh
# ============================================================================
#  Slipgate — сборка TgWsProxy (CLI) для macOS из исходников Flowseal
#
#  Upstream НЕ публикует CLI-бинарник для macOS (в релизе только
#  TgWsProxy_macos_universal.dmg с GUI .app), поэтому собираем сами.
#
#  Требования: Python 3.11 (желательно python.org — universal2), venv с
#  pyinstaller и зависимостями, исходники tg-ws-proxy рядом со Slipgate.
#
#  ВАЖНО про подпись: бинарник НЕЛЬЗЯ подписывать с hardened runtime
#  (codesign --options runtime). PyInstaller onefile распаковывает
#  Python.framework во временный каталог; с включённой library validation
#  dylib (подписана другим Team ID) не загружается:
#     [PYI-...] Failed to load Python shared library ... different Team IDs
#  Поэтому подписываем ad-hoc и БЕЗ --options runtime. Финальную подпись
#  (с hardened runtime) делает electron-builder при сборке Slipgate.app —
#  а Slipgate перед запуском переподписывает копию в runtime-каталоге.
# ============================================================================
set -eu

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROXY_DIR="${PROXY_DIR:-$ROOT/../tg-ws-proxy}"
VENV_PY="${VENV_PY:-$ROOT/../unified_proxy/venv/bin/python3}"
ENTRY="$ROOT/scripts/build-tgws/_pyi_entry.py"
OUT="$ROOT/resources/macos/tgws"

if [ ! -x "$VENV_PY" ]; then
  echo "[ERROR] Python venv not found: $VENV_PY"
  echo "        python3 -m venv venv && venv/bin/pip install pyinstaller cryptography"
  exit 1
fi
if [ ! -f "$PROXY_DIR/proxy/tg_ws_proxy.py" ]; then
  echo "[ERROR] tg-ws-proxy source missing: $PROXY_DIR (переопределите PROXY_DIR)"
  exit 1
fi

rm -rf "$ROOT/.pyi-build"
mkdir -p "$OUT"
rm -f "$OUT/TgWsProxy"

"$VENV_PY" -m PyInstaller --onefile --console --name "TgWsProxy" \
  --distpath "$OUT" --workpath "$ROOT/.pyi-build" --specpath "$ROOT/.pyi-build" \
  --paths "$PROXY_DIR" \
  --collect-submodules proxy \
  --collect-submodules cryptography \
  --hidden-import proxy \
  --hidden-import proxy.tg_ws_proxy \
  --hidden-import proxy.bridge \
  --hidden-import proxy.config \
  --hidden-import proxy.balancer \
  --hidden-import proxy.fake_tls \
  --hidden-import proxy.raw_websocket \
  --hidden-import proxy.stats \
  --hidden-import proxy.utils \
  --codesign-identity - \
  "$ENTRY"

BIN="$OUT/TgWsProxy"
chmod 755 "$BIN"

# Снимаем карантин и переподписываем ad-hoc (БЕЗ hardened runtime).
xattr -d com.apple.quarantine "$BIN" 2>/dev/null || true
codesign --force --sign - --timestamp=none "$BIN"

echo
echo "[OK] Built: $BIN"
codesign -dv "$BIN" 2>&1 | grep -E '^(Identifier|Flags|TeamIdentifier)' || true
"$BIN" --help >/dev/null 2>&1 && echo "[OK] smoke test passed" || echo "[WARN] smoke test: проверьте запуск вручную"
