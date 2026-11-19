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
set -Eeuo pipefail
# Name the command that failed, so the journal shows more than an exit code.
trap 'rc=$?; echo "incus-webui-host-updates: line $LINENO: \"$BASH_COMMAND\" failed with exit code $rc" >&2' ERR

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
  # Read apt-cache's whole output before parsing it. Closing the pipe early
  # makes apt fail with a write error when SIGPIPE is ignored, as under systemd.
  local out
  out="$(apt-cache policy "$1")" || { echo "apt-cache policy $1 failed" >&2; return 0; }
  printf '%s\n' "$out" | awk -v f="$2:" '$1 == f && !done {print $2; done = 1}'
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
  if apt-get update -q >/tmp/incus-webui-apt-update.log 2>&1; then
    touch "$STAMP"
  else
    local rc=$?
    echo "apt-get update failed with exit code $rc:" >&2
    tail -n 20 /tmp/incus-webui-apt-update.log >&2
    return "$rc"
  fi
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
  # Do a first run now and only report success if it worked.
  if ! systemctl start $UNIT.service; then
    echo >&2
    journalctl -u $UNIT.service -n 20 --no-pager -o cat >&2 || true
    die "the first run failed (see above). Nothing is scheduled yet. Send this output to the Incus WebUI issues page."
  fi
  systemctl enable --now $UNIT.timer >/dev/null 2>&1
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
