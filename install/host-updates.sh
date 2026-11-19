#!/usr/bin/env bash
# Lets Incus WebUI update Incus on a Debian or Ubuntu host.
#
#   curl -fsSL https://github.com/baki2001/Incus-WebUI/releases/latest/download/host-updates.sh | sudo bash
#
# This installs a systemd timer that runs once a minute. Each run it:
#   - reads the server setting user.incus-webui.update-request, which the UI sets
#     when you press "Check now" or "Update Incus";
#   - runs "apt-get update" when asked, or every 6 hours;
#   - upgrades the installed incus packages when asked, and nothing else;
#   - writes the installed and available versions to user.incus-webui.updates,
#     where the UI reads them.
#
# Remove it with: sudo incus-webui-host-updates uninstall
set -euo pipefail

BIN=/usr/local/sbin/incus-webui-host-updates
UNIT=incus-webui-host-updates
STAMP=/var/lib/incus-webui-host-updates/last-apt-update
REQ_KEY=user.incus-webui.update-request
STATUS_KEY=user.incus-webui.updates

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

packages() {
  dpkg-query -W -f='${binary:Package} ${db:Status-Status}\n' 'incus*' 2>/dev/null | awk '$2 == "installed" {print $1}'
}

field() { # field PACKAGE Installed|Candidate
  apt-cache policy "$1" 2>/dev/null | awk -v f="$2:" '$1 == f {print $2; exit}'
}

json_str() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr -d '\n\r'; }

write_status() { # write_status STATE MESSAGE
  local now installed candidate checked
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  installed="$(field incus Installed)"
  candidate="$(field incus Candidate)"
  checked="$(date -u -r "$STAMP" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)"
  incus config set "$STATUS_KEY" \
    "{\"installed\":\"$(json_str "$installed")\",\"candidate\":\"$(json_str "$candidate")\",\"checked\":\"$checked\",\"state\":\"$1\",\"message\":\"$(json_str "$2")\",\"updated\":\"$now\"}"
}

apt_update() {
  mkdir -p "$(dirname "$STAMP")"
  apt-get update -qq >/dev/null && touch "$STAMP"
}

run_once() {
  local req message=""
  req="$(incus config get "$REQ_KEY" 2>/dev/null || true)"
  [ -z "$req" ] || incus config unset "$REQ_KEY"

  case "$req" in
    upgrade*)
      write_status upgrading "Updating Incus"
      apt_update || true
      local before
      before="$(field incus Installed)"
      # Only the incus packages that are already installed are upgraded.
      # shellcheck disable=SC2046
      if DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --only-upgrade \
        -o Dpkg::Options::=--force-confold $(packages) >/tmp/incus-webui-upgrade.log 2>&1; then
        if [ "$(field incus Installed)" = "$before" ]; then
          message="Already up to date"
        else
          message="Updated from $before to $(field incus Installed)"
        fi
      else
        message="The update failed. See: journalctl -u $UNIT"
        cat /tmp/incus-webui-upgrade.log >&2
      fi
      # Incus restarts during the upgrade. Wait until it answers again.
      for _ in $(seq 1 60); do incus info >/dev/null 2>&1 && break; sleep 2; done
      write_status idle "$message"
      return
      ;;
    check*)
      apt_update || message="apt-get update failed"
      ;;
    *)
      if [ ! -e "$STAMP" ] || [ -n "$(find "$STAMP" -mmin +360)" ]; then
        apt_update || message="apt-get update failed"
      fi
      ;;
  esac
  # Keep the last message unless there's a new one.
  if [ -z "$message" ]; then
    message="$(incus config get "$STATUS_KEY" 2>/dev/null | sed -n 's/.*"message":"\([^"]*\)".*/\1/p')"
  fi
  write_status idle "$message"
}

install_self() {
  command -v incus >/dev/null || die "incus is not installed on this machine."
  command -v apt-get >/dev/null || die "this helper needs apt (Debian or Ubuntu). On IncusOS, the UI updates the system without it."
  [ -n "$(packages)" ] || die "Incus doesn't come from an apt package here, so this helper can't update it."
  [ "$(id -u)" = 0 ] || die "run this as root."

  local src="${BASH_SOURCE[0]:-}"
  if [ -n "$src" ] && [ -f "$src" ]; then
    install -m 0755 "$src" "$BIN"
  else
    # Piped into bash: fetch a copy to keep.
    curl -fsSL https://github.com/baki2001/Incus-WebUI/releases/latest/download/host-updates.sh -o "$BIN"
    chmod 0755 "$BIN"
  fi

  cat >/etc/systemd/system/$UNIT.service <<EOF
[Unit]
Description=Incus updates requested from Incus WebUI
After=incus.service

[Service]
Type=oneshot
ExecStart=$BIN run
EOF
  cat >/etc/systemd/system/$UNIT.timer <<EOF
[Unit]
Description=Check for Incus update requests from Incus WebUI

[Timer]
OnBootSec=1min
OnUnitActiveSec=1min
AccuracySec=5s

[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now $UNIT.timer >/dev/null 2>&1
  systemctl start $UNIT.service || true
  echo "Incus updates from the web UI are on. The host page shows the versions within a minute."
}

uninstall_self() {
  systemctl disable --now $UNIT.timer >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/$UNIT.service /etc/systemd/system/$UNIT.timer "$BIN"
  rm -rf "$(dirname "$STAMP")"
  systemctl daemon-reload
  incus config unset "$STATUS_KEY" 2>/dev/null || true
  incus config unset "$REQ_KEY" 2>/dev/null || true
  echo "Removed."
}

case "${1:-install}" in
  run) run_once </dev/null ;;
  install) install_self </dev/null ;;
  uninstall) uninstall_self ;;
  *) die "usage: $0 [install|run|uninstall]" ;;
esac
