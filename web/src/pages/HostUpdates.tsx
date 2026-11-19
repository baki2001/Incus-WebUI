import { useState } from "react";
import { dateTime, incus, since } from "../api";
import { invalidate, useApp, useData } from "../state";
import { confirmDialog, CopyBtn } from "../ui";

const ago = (iso?: string) => {
  const t = since(iso);
  return t === "–" || t === "just now" ? t : `${t} ago`;
};

const REQ = "user.incus-webui.update-request";
const STATUS = "user.incus-webui.updates";
const HELPER = "curl -fsSL https://github.com/baki2001/Incus-WebUI/releases/latest/download/host-updates.sh | sudo bash";

// hostBusy tells the host page to reload its settings often while the helper
// works on a request.
export function hostBusy(config: Record<string, string> | undefined) {
  if (!config) return false;
  return !!config[REQ] || (config[STATUS] || "").includes('"state":"upgrading"');
}

// Updates for the host: IncusOS updates itself through its own API, a Debian or
// Ubuntu host needs the small helper from install/host-updates.sh.
export function HostUpdates({ server, incusOS, config }: { server: string; incusOS: boolean; config: Record<string, string> }) {
  return (
    <div className="panel">
      <div className="ptitle">
        <h2>Updates</h2>
      </div>
      <div className="upd-body">{incusOS ? <IncusOSUpdates server={server} /> : <AptUpdates server={server} config={config} />}</div>
    </div>
  );
}

type AptStatus = { installed: string; candidate: string; checked: string; state: string; message: string; updated: string };

function AptUpdates({ server, config }: { server: string; config: Record<string, string> }) {
  const app = useApp();
  const raw = config[STATUS];
  const pending = config[REQ] || "";
  let st: AptStatus | null = null;
  try {
    st = raw ? JSON.parse(raw) : null;
  } catch {
    st = null;
  }
  const busy = !!pending || st?.state === "upgrading";

  const request = async (what: "check" | "upgrade") => {
    if (what === "upgrade") {
      const ok = await confirmDialog({
        title: `Update Incus on ${server}?`,
        body: "The host installs the new Incus packages and restarts the Incus service. Instances keep running. The UI loses the connection to this server for a moment.",
        confirm: "Update Incus",
      });
      if (!ok) return;
    }
    try {
      await incus(server, "/1.0", { method: "PATCH", body: { config: { [REQ]: `${what}:${Date.now()}` } } });
      invalidate(`hostinfo:${server}`);
    } catch (e: any) {
      app.toast(e.message);
    }
  };

  if (!st) {
    return (
      <>
        <p>
          Incus here comes from your distribution's packages, so the UI can't update it on its own. Run this once on the server to allow it. It adds a
          small timer that only upgrades the Incus packages when you ask from this page.
        </p>
        <div className="cmd">
          <code className="mono">{HELPER}</code>
          <CopyBtn text={HELPER} />
        </div>
      </>
    );
  }

  const newer = st.candidate && st.installed && st.candidate !== st.installed;
  return (
    <>
      <dl className="kv">
        <dt>Installed</dt>
        <dd className="mono">{st.installed || "–"}</dd>
        <dt>Available</dt>
        <dd className={newer ? "mono" : undefined}>{newer ? st.candidate : "You have the newest version"}</dd>
        <dt>Last checked</dt>
        <dd title={dateTime(st.checked)}>{ago(st.checked)}</dd>
        {st.message && (
          <>
            <dt>Last result</dt>
            <dd>{st.message}</dd>
          </>
        )}
      </dl>
      <div className="upd-row">
        {newer && (
          <button className="btn btn-p press" disabled={busy} onClick={() => request("upgrade")}>
            Update to {st.candidate}
          </button>
        )}
        <button className="btn btn-s press" disabled={busy} onClick={() => request("check")}>
          Check now
        </button>
        {busy && <span className="upd-wait">{st.state === "upgrading" ? "Updating Incus…" : "Waiting for the host, up to a minute…"}</span>}
      </div>
    </>
  );
}

type OSUpdate = {
  config: { channel: string; check_frequency: string; auto_reboot: boolean };
  state: { last_check: string; status: string; needs_reboot: boolean };
};

function IncusOSUpdates({ server }: { server: string }) {
  const app = useApp();
  const os = useData<any>(`os:${server}`, () => incus(server, "/os/1.0"), 15000);
  const upd = useData<OSUpdate>(`os-update:${server}`, () => incus(server, "/os/1.0/system/update"), 5000);
  const [busy, setBusy] = useState(false);
  const env = os.data?.environment || {};
  const u = upd.data;

  const check = async () => {
    setBusy(true);
    try {
      await incus(server, "/os/1.0/system/update/:check", { method: "POST", body: {} });
      app.toast("IncusOS is checking for updates. New versions install on their own.");
      setTimeout(() => invalidate(`os-update:${server}`), 1500);
    } catch (e: any) {
      app.toast(e.message);
    }
    setBusy(false);
  };

  const reboot = async () => {
    const ok = await confirmDialog({
      title: `Restart ${server}?`,
      body: "The server restarts to finish the IncusOS update. All instances on it stop and start again.",
      confirm: "Restart server",
      danger: true,
      typeToConfirm: server,
    });
    if (!ok) return;
    try {
      await incus(server, "/os/1.0/system/:reboot", { method: "POST", body: {} });
      app.toast(`${server} is restarting.`);
    } catch (e: any) {
      app.toast(e.message);
    }
  };

  if (upd.error) return <p>{upd.error}</p>;
  return (
    <>
      <dl className="kv">
        <dt>IncusOS</dt>
        <dd className="mono">{env.os_version || "–"}</dd>
        {env.os_version_next && env.os_version_next !== env.os_version && (
          <>
            <dt>Installed, needs restart</dt>
            <dd className="mono">{env.os_version_next}</dd>
          </>
        )}
        <dt>Channel</dt>
        <dd>{u?.config.channel || "–"}</dd>
        <dt>Automatic checks</dt>
        <dd>{!u ? "–" : u.config.check_frequency === "never" ? "Off" : `Every ${u.config.check_frequency}`}</dd>
        <dt>Last checked</dt>
        <dd title={dateTime(u?.state.last_check)}>{ago(u?.state.last_check)}</dd>
        {u?.state.status && (
          <>
            <dt>Status</dt>
            <dd>{u.state.status}</dd>
          </>
        )}
      </dl>
      <div className="upd-row">
        {u?.state.needs_reboot && (
          <button className="btn btn-p press" onClick={reboot}>
            Restart to finish the update
          </button>
        )}
        <button className="btn btn-s press" disabled={busy} onClick={check}>
          {busy ? "Checking…" : "Check now"}
        </button>
      </div>
    </>
  );
}
