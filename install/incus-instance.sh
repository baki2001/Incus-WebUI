#!/usr/bin/env bash
# Installs Incus WebUI as a container on this Incus host, or updates it.
#
#   curl -fsSL https://raw.githubusercontent.com/baki2001/Incus-WebUI/main/install/incus-instance.sh | sudo bash
#
# Settings (environment variables):
#   NAME          instance name                          (default: incus-webui)
#   PORT          port on the host for the UI            (default: 9443)
#   IMAGE         image for the container                (default: images:debian/13)
#   VERSION       release tag, or "latest"               (default: latest)
#   HOST_UPDATES  1 lets the UI update Incus on this host (default: 1, apt hosts only)
#   BINARY        use this local binary instead of downloading one
set -euo pipefail

NAME="${NAME:-incus-webui}"
PORT="${PORT:-9443}"
IMAGE="${IMAGE:-images:debian/13}"
VERSION="${VERSION:-latest}"
HOST_UPDATES="${HOST_UPDATES:-1}"
REPO="baki2001/Incus-WebUI"
DATA=/var/lib/incus-webui
# The binary lives in a folder its own user can write, so the UI can update itself.
APP=/opt/incus-webui

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

# Everything runs inside main, so bash reads the whole script before it starts.
# With "curl | bash", commands like incus exec would otherwise read the rest of
# the script from stdin.
main() {
  command -v incus >/dev/null || die "incus is not installed on this machine."
  incus info >/dev/null 2>&1 || die "can't talk to Incus. Run this as root or as a member of the incus-admin group."

  case "$(uname -m)" in
    x86_64 | amd64) ARCH=amd64 ;;
    aarch64 | arm64) ARCH=arm64 ;;
    *) die "unsupported CPU architecture: $(uname -m)" ;;
  esac

  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  if [ "$VERSION" = latest ]; then
    URL="https://github.com/$REPO/releases/latest/download"
  else
    URL="https://github.com/$REPO/releases/download/$VERSION"
  fi

  get_binary

  if incus info "$NAME" >/dev/null 2>&1; then
    say "Updating the existing instance $NAME"
    install_app
    incus exec "$NAME" -- systemctl restart incus-webui
    host_updates
    say "Done. $(incus exec "$NAME" -- $APP/incus-webui --version) is running."
    exit 0
  fi

  if command -v ss >/dev/null && ss -ltnH "sport = :$PORT" | grep -q .; then
    die "port $PORT is already in use on this machine. Pick another one, for example: PORT=9444"
  fi

  https_address
  create_container
  install_app

  # Connect the UI to this Incus server with a one-time trust token.
  SERVER="$(hostname -s | tr -c 'a-zA-Z0-9-\n' '-' | sed 's/^-*//' | cut -c1-63)"
  [ -n "$SERVER" ] || SERVER=local
  say "Connecting the UI to this server as \"$SERVER\""
  TOKEN="$(incus config trust add "$NAME" --quiet)"
  incus exec "$NAME" -- runuser -u incus-webui -- $APP/incus-webui add-server --data "$DATA" "$SERVER" "$TOKEN"

  incus exec "$NAME" -- systemctl enable --now incus-webui >/dev/null 2>&1

  # Publish the UI on the host.
  incus config device add "$NAME" https proxy "listen=tcp:0.0.0.0:$PORT" "connect=tcp:127.0.0.1:8443" >/dev/null

  host_updates

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
}

get_binary() {
  if [ -n "${BINARY:-}" ]; then
    cp "$BINARY" "$TMP/incus-webui"
  else
    say "Downloading incus-webui ($VERSION, $ARCH)"
    curl -fsSL "$URL/incus-webui-linux-$ARCH" -o "$TMP/incus-webui"
    curl -fsSL "$URL/SHA256SUMS" -o "$TMP/SHA256SUMS"
    (cd "$TMP" && grep " incus-webui-linux-$ARCH\$" SHA256SUMS | sed "s/incus-webui-linux-$ARCH/incus-webui/" | sha256sum -c --quiet) \
      || die "checksum mismatch for the downloaded binary"
  fi
  chmod 0755 "$TMP/incus-webui"
}

# Lets Incus listen on HTTPS, so the UI can reach it from its container.
https_address() {
  local addr net gw
  addr="$(incus config get core.https_address)"
  [ -z "$addr" ] || return 0
  net="$(incus profile device get default eth0 network 2>/dev/null || true)"
  [ -n "$net" ] || die "the default profile has no eth0 network. Set core.https_address yourself and run this again."
  gw="$(incus network get "$net" ipv4.address)"
  gw="${gw%/*}"
  [ -n "$gw" ] && [ "$gw" != none ] || die "network $net has no IPv4 address. Set core.https_address yourself and run this again."
  say "Letting Incus listen on $gw:8443 (only reachable from its own bridge, $net)"
  incus config set core.https_address "$gw:8443"
}

create_container() {
  say "Creating container $NAME from $IMAGE"
  incus launch -q "$IMAGE" "$NAME" -c boot.autostart=true
  printf 'Waiting for it to boot'
  local state
  for _ in $(seq 1 60); do
    state="$(incus exec "$NAME" -- systemctl is-system-running 2>/dev/null || true)"
    case "$state" in running | degraded) break ;; esac
    printf '.'
    sleep 1
  done
  echo
}

# Puts the binary and the service in place. Safe to run again on an existing
# install, and moves installs from before v0.2 (binary in /usr/local/bin) over.
install_app() {
  cat >"$TMP/incus-webui.service" <<EOF
[Unit]
Description=Incus WebUI
After=network-online.target
Wants=network-online.target

[Service]
User=incus-webui
Group=incus-webui
ExecStart=$APP/incus-webui --data $DATA
StateDirectory=incus-webui
StateDirectoryMode=0700
ReadWritePaths=$APP
Restart=on-failure
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF
  incus exec "$NAME" -- sh -c "id incus-webui >/dev/null 2>&1 || useradd --system --home-dir $DATA --shell /usr/sbin/nologin incus-webui"
  incus exec "$NAME" -- install -d -m 0700 -o incus-webui -g incus-webui "$DATA"
  # The UI checks GitHub for its own updates over HTTPS, which needs the CA list.
  incus exec "$NAME" -- sh -c "[ -e /etc/ssl/certs/ca-certificates.crt ] || (apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ca-certificates) >/dev/null 2>&1 || true"
  incus exec "$NAME" -- install -d -m 0755 -o incus-webui -g incus-webui "$APP"
  # Push next to the running binary and rename, since a running file can't be overwritten.
  incus file push -q "$TMP/incus-webui" "$NAME$APP/incus-webui.new" --mode 0755
  incus exec "$NAME" -- sh -c "chown incus-webui:incus-webui $APP/incus-webui.new && mv -f $APP/incus-webui.new $APP/incus-webui && ln -sf $APP/incus-webui /usr/local/bin/incus-webui"
  incus file push -q "$TMP/incus-webui.service" "$NAME/etc/systemd/system/incus-webui.service"
  incus exec "$NAME" -- systemctl daemon-reload
}

# On hosts where Incus comes from apt, adds the small helper that lets the UI
# update Incus. See install/host-updates.sh.
host_updates() {
  [ "$HOST_UPDATES" = 1 ] || return 0
  command -v apt-get >/dev/null || return 0
  dpkg-query -W -f='${db:Status-Status}' incus 2>/dev/null | grep -q '^installed' || return 0
  [ "$(id -u)" = 0 ] || { say "Skipping Incus updates from the UI: that part needs root."; return 0; }
  local helper="$TMP/host-updates.sh" here
  here="$(dirname "${BASH_SOURCE[0]:-}")"
  if [ -n "${BINARY:-}" ] && [ -f "$here/host-updates.sh" ]; then
    cp "$here/host-updates.sh" "$helper"
  elif ! curl -fsSL "$URL/host-updates.sh" -o "$helper" 2>/dev/null; then
    say "Skipping Incus updates from the UI: this release doesn't include the helper."
    return 0
  fi
  say "Letting the UI update Incus on this host (HOST_UPDATES=0 turns this off)"
  bash "$helper" install
}

main "$@" </dev/null
