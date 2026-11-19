#!/usr/bin/env bash
# Installs Incus WebUI as a container on this Incus host, or updates it.
#
#   curl -fsSL https://raw.githubusercontent.com/baki2001/Incus-WebUI/main/install/incus-instance.sh | sudo bash
#
# Settings (environment variables):
#   NAME     instance name                 (default: incus-webui)
#   PORT     port on the host for the UI   (default: 9443)
#   IMAGE    image for the container       (default: images:debian/13)
#   VERSION  release tag, or "latest"      (default: latest)
#   BINARY   use this local binary instead of downloading one
set -euo pipefail

NAME="${NAME:-incus-webui}"
PORT="${PORT:-9443}"
IMAGE="${IMAGE:-images:debian/13}"
VERSION="${VERSION:-latest}"
REPO="baki2001/Incus-WebUI"
DATA=/var/lib/incus-webui

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

command -v incus >/dev/null || die "incus is not installed on this machine."
incus info >/dev/null 2>&1 || die "can't talk to Incus. Run this as root or as a member of the incus-admin group."

case "$(uname -m)" in
  x86_64 | amd64) ARCH=amd64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *) die "unsupported CPU architecture: $(uname -m)" ;;
esac

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 1. Get the binary
if [ -n "${BINARY:-}" ]; then
  cp "$BINARY" "$TMP/incus-webui"
else
  if [ "$VERSION" = latest ]; then
    URL="https://github.com/$REPO/releases/latest/download"
  else
    URL="https://github.com/$REPO/releases/download/$VERSION"
  fi
  say "Downloading incus-webui ($VERSION, $ARCH)"
  curl -fsSL "$URL/incus-webui-linux-$ARCH" -o "$TMP/incus-webui"
  curl -fsSL "$URL/SHA256SUMS" -o "$TMP/SHA256SUMS"
  (cd "$TMP" && grep " incus-webui-linux-$ARCH\$" SHA256SUMS | sed "s/incus-webui-linux-$ARCH/incus-webui/" | sha256sum -c --quiet) \
    || die "checksum mismatch for the downloaded binary"
fi
chmod 0755 "$TMP/incus-webui"

# Update an existing install: swap the binary and restart.
if incus info "$NAME" >/dev/null 2>&1; then
  say "Updating the existing instance $NAME"
  incus file push "$TMP/incus-webui" "$NAME/usr/local/bin/incus-webui" --mode 0755
  incus exec "$NAME" -- systemctl restart incus-webui
  say "Done. $(incus exec "$NAME" -- /usr/local/bin/incus-webui --version) is running."
  exit 0
fi

# 2. Make sure Incus listens on HTTPS, so the UI can reach it from its container.
ADDR="$(incus config get core.https_address)"
if [ -z "$ADDR" ]; then
  NET="$(incus profile device get default eth0 network 2>/dev/null || true)"
  [ -n "$NET" ] || die "the default profile has no eth0 network. Set core.https_address yourself and run this again."
  GW="$(incus network get "$NET" ipv4.address)"
  GW="${GW%/*}"
  [ -n "$GW" ] && [ "$GW" != none ] || die "network $NET has no IPv4 address. Set core.https_address yourself and run this again."
  say "Letting Incus listen on $GW:8443 (only reachable from its own bridge, $NET)"
  incus config set core.https_address "$GW:8443"
fi

# 3. Create the container
say "Creating container $NAME from $IMAGE"
incus launch "$IMAGE" "$NAME" -c boot.autostart=true
printf 'Waiting for it to boot'
for _ in $(seq 1 60); do
  state="$(incus exec "$NAME" -- systemctl is-system-running 2>/dev/null || true)"
  case "$state" in running | degraded) break ;; esac
  printf '.'
  sleep 1
done
echo

# 4. Install the binary and the service
cat >"$TMP/incus-webui.service" <<'EOF'
[Unit]
Description=Incus WebUI
After=network-online.target
Wants=network-online.target

[Service]
User=incus-webui
Group=incus-webui
ExecStart=/usr/local/bin/incus-webui --data /var/lib/incus-webui
StateDirectory=incus-webui
StateDirectoryMode=0700
Restart=on-failure
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF
incus file push "$TMP/incus-webui" "$NAME/usr/local/bin/incus-webui" --mode 0755
incus file push "$TMP/incus-webui.service" "$NAME/etc/systemd/system/incus-webui.service"
incus exec "$NAME" -- sh -c "id incus-webui >/dev/null 2>&1 || useradd --system --home-dir $DATA --shell /usr/sbin/nologin incus-webui"
incus exec "$NAME" -- install -d -m 0700 -o incus-webui -g incus-webui "$DATA"

# 5. Connect the UI to this Incus server with a one-time trust token
SERVER="$(hostname -s | tr -c 'a-zA-Z0-9-\n' '-' | sed 's/^-*//' | cut -c1-63)"
[ -n "$SERVER" ] || SERVER=local
say "Connecting the UI to this server as \"$SERVER\""
TOKEN="$(incus config trust add "$NAME" --quiet)"
incus exec "$NAME" -- runuser -u incus-webui -- /usr/local/bin/incus-webui add-server --data "$DATA" "$SERVER" "$TOKEN"

incus exec "$NAME" -- systemctl daemon-reload
incus exec "$NAME" -- systemctl enable --now incus-webui >/dev/null 2>&1

# 6. Publish the UI on the host
incus config device add "$NAME" https proxy "listen=tcp:0.0.0.0:$PORT" "connect=tcp:127.0.0.1:8443" >/dev/null

CODE=""
for _ in $(seq 1 15); do
  CODE="$(incus exec "$NAME" -- journalctl -u incus-webui -o cat --no-pager 2>/dev/null | grep -o 'setup code to create your account: [0-9a-f]*' | tail -1 | awk '{print $NF}')"
  [ -n "$CODE" ] && break
  sleep 1
done

HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
say "Incus WebUI is running."
echo "    Open        https://${HOST_IP:-this-host}:$PORT"
echo "    Setup code  ${CODE:-see: incus exec $NAME -- journalctl -u incus-webui}"
echo
echo "Your browser will warn about the certificate the first time. That's expected:"
echo "the UI makes its own certificate. You can add a real one later (see the docs)."
