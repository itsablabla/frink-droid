#!/bin/bash
# Start Frink in web mode inside the container: a private D-Bus session with an unlocked keyring
# (Electron's safeStorage keeps agent credentials there) and an in-memory Xvfb display that is
# never shown or streamed. The UI is served over HTTP on FRINK_WEB_PORT.
set -euo pipefail

FRINK_UID=501
FRINK_GID=20

# Hosted platforms (Hostim) mount a fresh volume root-owned and cannot pick the container user.
# Started as root: hand the volumes to frink, then drop privileges for good.
if [[ "$(id -u)" == 0 ]]; then
  for dir in /home/frink /workspace; do
    mkdir -p "$dir"
    find "$dir" -xdev \( ! -uid "$FRINK_UID" -o ! -gid "$FRINK_GID" \) \
      -exec chown -h "$FRINK_UID:$FRINK_GID" {} +
  done
  chmod 0700 /home/frink
  exec setpriv --reuid="$FRINK_UID" --regid="$FRINK_GID" --init-groups \
    env HOME=/home/frink USER=frink LOGNAME=frink "$0" "$@"
fi

if [[ -z "${FRINK_WEB_PASSWORD:-}" && -z "${FRINK_WEB_PASSWORD_HASH:-}" ]]; then
  echo "frink-web: set FRINK_WEB_PASSWORD (12+ characters) or FRINK_WEB_PASSWORD_HASH" >&2
  exit 64
fi

# The folder picker's roots must exist; on hosts with one volume they live inside $HOME.
IFS=':, ' read -r -a web_roots <<< "${FRINK_WEB_ROOTS:-}"
for root in "${web_roots[@]}"; do
  [[ -n "$root" ]] && mkdir -p "$root"
done

# The keyring's own password only protects the file at rest inside this volume; it is derived
# per container home so it never needs to be configured or exposed.
mkdir -p "$HOME/.config"
keyring_secret_file="$HOME/.config/frink-web-keyring"
if [[ ! -s "$keyring_secret_file" ]]; then
  (umask 077 && head -c 32 /dev/urandom | base64 > "$keyring_secret_file")
fi

# Small plans (2 GB) fit one agent at a time. Seed Frink's Flow admission default on first boot
# only; after that the setting belongs to the person (Settings → Flows) and is never overwritten.
flows_config="$HOME/.frink/flows/config.json"
max_runs="${FRINK_WEB_MAX_FLOW_RUNS:-}"
if [[ -n "$max_runs" && ! -e "$flows_config" ]]; then
  if [[ ! "$max_runs" =~ ^[1-9][0-9]*$ ]] || ((max_runs > 100)); then
    echo "frink-web: FRINK_WEB_MAX_FLOW_RUNS must be an integer from 1 to 100" >&2
    exit 64
  fi
  mkdir -p "$(dirname "$flows_config")"
  (umask 077 && printf '{\n  "version": 1,\n  "queuePaused": false,\n  "concurrencyLimitEnabled": true,\n  "maxConcurrentRuns": %d\n}\n' \
    "$max_runs" > "$flows_config")
fi

# Optional cap on the main process's JS heap (MB), for small plans.
heap_flag=()
if [[ -n "${FRINK_WEB_MAX_HEAP_MB:-}" ]]; then
  if [[ ! "$FRINK_WEB_MAX_HEAP_MB" =~ ^[1-9][0-9]*$ ]]; then
    echo "frink-web: FRINK_WEB_MAX_HEAP_MB must be a positive integer" >&2
    exit 64
  fi
  heap_flag=("--js-flags=--max-old-space-size=$FRINK_WEB_MAX_HEAP_MB")
fi

exec dbus-run-session -- bash -c '
  set -euo pipefail
  keyring_secret_file="$1"
  shift
  eval "$(gnome-keyring-daemon --unlock --components=secrets < "$keyring_secret_file" 2>/dev/null)"
  export GNOME_KEYRING_CONTROL SSH_AUTH_SOCK
  # The display is never shown: keep it tiny so Xvfb holds almost no memory.
  exec xvfb-run -a -s "-screen 0 640x480x16 -nolisten tcp" \
    /opt/Frink/frink --no-sandbox --password-store=gnome-libsecret \
    --disable-gpu --disable-dev-shm-usage "$@"
' frink-web "$keyring_secret_file" "${heap_flag[@]}"
