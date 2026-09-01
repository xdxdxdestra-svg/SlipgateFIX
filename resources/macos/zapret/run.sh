#!/bin/sh
set -eu

DATA_ROOT=$1
BASE='/Library/Application Support/ZapretMac'
ANCHOR=com.apple/zapret-macos
TOKEN_FILE=/var/run/zapret-macos.pf-token
KEEPINIT_FILE=/var/db/zapret-macos.keepinit
ENGINE_PID=
WATCHDOG_PID=

# ---- Early logging -------------------------------------------------------
# Upstream run.sh only opens engine.log at the utunws spawn (near the end),
# so any failure in the pre-flight phase (default route / gateway MAC / ARP /
# lists) exited SILENTLY with no trace. We open it here so every early exit
# leaves a readable reason. Truncate on start is intentional: a fresh run
# replaces the previous attempt's notes; on success utunws appends below.
: > "$BASE/engine.log" 2>/dev/null || true
logf() { echo "[preflight $(/bin/date +%H:%M:%S)] $*" >> "$BASE/engine.log" 2>/dev/null || true; }
logf "run.sh started (DATA_ROOT=$DATA_ROOT)"

case "$DATA_ROOT" in
    /Users/*/'Library/Application Support/ZapretMac') ;;
    *) logf "DATA_ROOT format rejected: $DATA_ROOT"; exit 1 ;;
esac

if [ -s "$KEEPINIT_FILE" ]; then
    /usr/sbin/sysctl -w net.inet.tcp.keepinit=7000 >/dev/null
fi

clear_intercept() {
    /sbin/pfctl -a "$ANCHOR" -F all >/dev/null 2>&1 || true
}

release_pf_token() {
    if [ -s "$TOKEN_FILE" ]; then
        TOKEN=$(/bin/cat "$TOKEN_FILE" 2>/dev/null || true)
        if [ -n "$TOKEN" ]; then /sbin/pfctl -X "$TOKEN" >/dev/null 2>&1 || true; fi
        /bin/rm -f "$TOKEN_FILE"
    fi
}

cleanup() {
    trap - EXIT INT TERM HUP
    clear_intercept
    if [ -n "$WATCHDOG_PID" ]; then kill "$WATCHDOG_PID" >/dev/null 2>&1 || true; fi
    if [ -n "$ENGINE_PID" ]; then kill "$ENGINE_PID" >/dev/null 2>&1 || true; fi
    if [ -n "$WATCHDOG_PID" ]; then wait "$WATCHDOG_PID" >/dev/null 2>&1 || true; fi
    if [ -n "$ENGINE_PID" ]; then wait "$ENGINE_PID" >/dev/null 2>&1 || true; fi
    release_pf_token
}

trap cleanup EXIT INT TERM HUP
clear_intercept
/usr/bin/pkill -9 -x utunws >/dev/null 2>&1 || true

# ---- Network detection with bounded retry --------------------------------
# The default gateway / ARP entry may not be ready the instant the LaunchDaemon
# (RunAtLoad) or a manual restart fires — e.g. Wi-Fi still associating, ARP
# cache not yet populated. A single probe can therefore see an empty gateway
# or an unresolved MAC and bail. Retry a few times (cheap, ~6s worst case) so
# a transient "not ready yet" does not become a permanent silent failure.
PHYSICAL_IFACE=
GATEWAY=
GATEWAY_MAC=
ATTEMPT=0
while [ "$ATTEMPT" -lt 6 ]; do
    ATTEMPT=$((ATTEMPT + 1))
    PHYSICAL_IFACE=$(/sbin/route -n get default | /usr/bin/awk '/interface:/{print $2; exit}')
    GATEWAY=$(/sbin/route -n get default | /usr/bin/awk '/gateway:/{print $2; exit}')
    if [ -n "$PHYSICAL_IFACE" ] && [ -n "$GATEWAY" ]; then
        /sbin/ping -c 1 -t 1 "$GATEWAY" >/dev/null 2>&1 || true
        GATEWAY_MAC=$(/usr/sbin/arp -n "$GATEWAY" | /usr/bin/awk '/ at /{print $4; exit}')
        if [ -n "$GATEWAY_MAC" ]; then
            logf "network ok: iface=$PHYSICAL_IFACE gateway=$GATEWAY mac=$GATEWAY_MAC (attempt $ATTEMPT)"
            break
        fi
        logf "attempt $ATTEMPT: gateway=$GATEWAY reachable but MAC unresolved (arp empty)"
    else
        logf "attempt $ATTEMPT: default route incomplete (iface='$PHYSICAL_IFACE' gateway='$GATEWAY')"
    fi
    /bin/sleep 1
done

if [ -z "$PHYSICAL_IFACE" ] || [ -z "$GATEWAY" ]; then
    logf "giving up: no default route after $ATTEMPT attempts"
    exit 1
fi
if [ -z "$GATEWAY_MAC" ]; then
    logf "giving up: gateway $GATEWAY MAC unresolved after $ATTEMPT attempts"
    exit 1
fi
case "$GATEWAY_MAC" in
    *:*:*:*:*:*) ;;
    *) logf "GATEWAY_MAC '$GATEWAY_MAC' is not a valid MAC"; exit 1 ;;
esac

GATEWAY6_MAC=
if /sbin/route -n get -inet6 default >/var/run/zapret-macos.route6 2>/dev/null; then
    GATEWAY6=$(/usr/bin/awk '/gateway:/{print $2; exit}' /var/run/zapret-macos.route6)
    if [ -n "$GATEWAY6" ]; then
        GATEWAY6_MAC=$(/usr/sbin/ndp -n "$GATEWAY6" 2>/dev/null | /usr/bin/awk '/ at |%/{for(i=1;i<=NF;i++) if($i ~ /^([0-9a-f]{1,2}:){5}[0-9a-f]{1,2}$/){print $i; exit}}')
    fi
fi
/bin/rm -f /var/run/zapret-macos.route6

STRATEGY=$(/usr/bin/tr -d '[:space:]' <"$DATA_ROOT/selected-strategy" 2>/dev/null || true)
if ! printf '%s\n' "$STRATEGY" | /usr/bin/grep -Eq '^general(-[a-z0-9]+)*$' || [ ! -f "$BASE/strategies/$STRATEGY.conf.in" ]; then
    logf "strategy '$STRATEGY' invalid or missing .conf.in — falling back to general-simple-fake"
    STRATEGY=general-simple-fake
fi
if [ ! -f "$BASE/strategies/$STRATEGY.conf.in" ]; then
    logf "FATAL: strategy $STRATEGY has no $BASE/strategies/$STRATEGY.conf.in"
    exit 1
fi

if [ -L "$DATA_ROOT" ] || [ -L "$DATA_ROOT/lists" ] || [ ! -d "$DATA_ROOT/lists" ]; then
    logf "lists dir missing or symlink: $DATA_ROOT/lists"
    exit 1
fi
RUNTIME_LISTS="$BASE/lists"
/bin/mkdir -p "$RUNTIME_LISTS"
for NAME in list-general.txt list-general-user.txt list-google.txt list-exclude.txt list-exclude-user.txt ipset-all.txt ipset-exclude.txt ipset-exclude-user.txt; do
    SOURCE_LIST="$DATA_ROOT/lists/$NAME"
    if [ -L "$SOURCE_LIST" ] || [ ! -f "$SOURCE_LIST" ]; then
        logf "required list missing: $SOURCE_LIST"
        exit 1
    fi
    /usr/bin/install -m 0644 "$SOURCE_LIST" "$RUNTIME_LISTS/$NAME"
done
/usr/sbin/chown -R root:wheel "$RUNTIME_LISTS"
/bin/chmod 755 "$RUNTIME_LISTS"

IPSET_MODE=$(/usr/bin/tr -d '[:space:]' <"$DATA_ROOT/ipset-mode" 2>/dev/null || true)
case "$IPSET_MODE" in
    loaded) IPSET="$RUNTIME_LISTS/ipset-all.txt" ;;
    any) IPSET="$BASE/ipset-any.txt" ;;
    *) IPSET="$BASE/ipset-none.txt" ;;
esac

logf "building pf config for strategy=$STRATEGY"
/usr/bin/sed -e "s|@BASE@|$BASE|g" -e "s|@LISTS@|$RUNTIME_LISTS|g" -e "s|@IPSET@|$IPSET|g" "$BASE/strategies/$STRATEGY.conf.in" > /var/run/zapret-macos.conf

export ZAPRET_IFACE="$PHYSICAL_IFACE"
export ZAPRET_GATEWAY_MAC="$GATEWAY_MAC"
export ZAPRET_GATEWAY6_MAC="$GATEWAY6_MAC"
export ZAPRET_UTUN_UNIT=51
logf "spawning utunws (strategy=$STRATEGY)"
"$BASE/bin/utunws" @/var/run/zapret-macos.conf >>"$BASE/engine.log" 2>&1 &
ENGINE_PID=$!

I=0
while ! /sbin/ifconfig utun50 >/dev/null 2>&1; do
    I=$((I + 1))
    if ! kill -0 "$ENGINE_PID" 2>/dev/null || [ "$I" -gt 100 ]; then
        logf "utunws died before utun50 appeared (I=$I)"
        exit 1
    fi
    sleep 0.1
done
/sbin/ifconfig utun50 10.77.0.1 10.77.0.2 netmask 255.255.255.255 up
"$BASE/watchdog.sh" $$ "$ENGINE_PID" &
WATCHDOG_PID=$!

if /sbin/pfctl -s info 2>/dev/null | /usr/bin/grep -q '^Status: Disabled'; then
    TOKEN=$(/sbin/pfctl -E 2>&1 | /usr/bin/awk '/Token :/ { print $3 }')
    if [ -n "$TOKEN" ]; then /bin/echo "$TOKEN" >"$TOKEN_FILE"; fi
fi

printf '%s\n' \
  'pass out quick route-to (utun50 10.77.0.2) inet proto tcp from any to any port {80,443,2053,2083,2087,2096,8443} user { >root } no state' \
  'pass out quick route-to (utun50 10.77.0.2) inet proto udp from any to any port {443,19294:19344,50000:50100} user { >root } no state' \
  | /sbin/pfctl -a "$ANCHOR" -f -

logf "run.sh started successfully (strategy=$STRATEGY)"
while kill -0 "$ENGINE_PID" 2>/dev/null; do
    sleep 2
    CURRENT_IFACE=$(/sbin/route -n get default 2>/dev/null | /usr/bin/awk '/interface:/{print $2; exit}')
    CURRENT_GATEWAY=$(/sbin/route -n get default 2>/dev/null | /usr/bin/awk '/gateway:/{print $2; exit}')
    if [ "$CURRENT_IFACE" != "$PHYSICAL_IFACE" ] || [ "$CURRENT_GATEWAY" != "$GATEWAY" ]; then
        logf "default route changed (iface $CURRENT_IFACE/$CURRENT_GATEWAY vs $PHYSICAL_IFACE/$GATEWAY) — exiting"
        exit 1
    fi
done
logf "utunws exited on its own"
exit 1
