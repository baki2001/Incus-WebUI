import { useEffect, useRef, useState } from "react";
import { bytes, dateTime, friendlyError, memBytes, ui, upload } from "../api";
import { invalidate, useApp, useData, useScopedServers } from "../state";
import { useManagedNetworks, useNames } from "../data";
import { Field, Input, Seg, Select, Sheet, SheetSec, TglRow } from "../ui";

type Upload = { id: string; name: string; kind: "container" | "virtual-machine"; size: number; created: string; expires: string };

type Snap = { ref: string; kind: "container" | "virtual-machine"; id: string; created: string; comment?: string; size?: number; problem?: string };

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
type Plan = {
  type: string;
  name: string;
  os?: string;
  config: Record<string, string>;
  devices: Record<string, Record<string, string>>;
  disk_size?: number;
  extra_disks?: { key: string; size: number }[];
  warnings: string[];
  blockers: string[];
};

const nameRe = /^[a-zA-Z][a-zA-Z0-9-]{0,62}$/;

type Kind = "proxmox" | "compose";

// Import from Proxmox (a vzdump backup) or Docker Compose (a compose file).
export function ImportSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [kind, setKind] = useState<Kind>("proxmox");
  const head = <Seg value={kind} onChange={setKind} label="Import from" options={[{ v: "proxmox", l: "Proxmox" }, { v: "compose", l: "Docker Compose" }]} />;
  return kind === "proxmox" ? <ProxmoxSheet open={open} onClose={onClose} head={head} /> : <ComposeSheet open={open} onClose={onClose} head={head} />;
}

function ProxmoxSheet({ open, onClose, head }: { open: boolean; onClose: () => void; head: React.ReactNode }) {
  const app = useApp();
  const servers = useScopedServers().filter((s) => app.can(s.name, "*", "manager"));
  const uploads = useData<Upload[]>(open ? "ui-imports" : null, () => ui("/imports"));
  const pbsList = useData<{ name: string; datastore: string }[]>(open ? "ui-pbs" : null, () => ui("/pbs"));
  const [from, setFrom] = useState<"file" | "pbs">("file");
  const [pbsName, setPbsName] = useState("");
  const pbs = pbsName || pbsList.data?.[0]?.name || "";
  const snaps = useData<Snap[]>(open && from === "pbs" && pbs ? `ui-pbs-snaps:${pbs}` : null, () => ui(`/pbs/${encodeURIComponent(pbs)}/snapshots`));
  const [snap, setSnap] = useState<Snap | null>(null);
  const [file, setFile] = useState<Upload | null>(null);
  const [sending, setSending] = useState<number | null>(null);
  const [err, setErr] = useState("");
  const input = useRef<HTMLInputElement>(null);

  const [server, setServer] = useState("");
  const srv = server || servers[0]?.name || "";
  const projects = useNames(open ? srv : "", "projects");
  const [proj, setProj] = useState("");
  const project = proj || (app.project !== "*" && app.can(srv, app.project, "manager") ? app.project : "") || (projects.data || []).find((p) => app.can(srv, p, "manager")) || "";
  const nets = useManagedNetworks(open ? srv : "", project || "default");
  const pools = useNames(open ? srv : "", "storage-pools", project || "default");
  const [net, setNet] = useState("");
  const [pool, setPool] = useState("");
  const network = net || nets.data?.[0]?.name || "";
  const storage = pool || (pools.data?.includes("default") ? "default" : pools.data?.[0]) || "";
  const [name, setName] = useState("");
  const [keepMAC, setKeepMAC] = useState(true);
  const [start, setStart] = useState(true);
  const [busy, setBusy] = useState(false);

  // What is being imported: an uploaded file or a backup on a PBS server.
  const chosen =
    from === "file"
      ? file && { label: `${file.name}, ${bytes(file.size)}`, base: `/imports/${file.id}`, extra: {} as Record<string, string> }
      : snap && { label: `${snap.ref} on ${pbs}`, base: `/pbs/${encodeURIComponent(pbs)}`, extra: { snap: snap.ref } as Record<string, string> };
  const qs = new URLSearchParams({ network, pool: storage, name, keep_mac: String(keepMAC), ...chosen?.extra });
  const plan = useData<Plan>(chosen && network && storage ? `import-plan:${chosen.base}:${qs}` : null, () => ui(`${chosen!.base}/plan?${qs}`));

  // The upload is the one step that needs this page; warn before leaving it.
  useEffect(() => {
    if (sending == null) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [sending != null]);

  useEffect(() => {
    if (!open) {
      setFile(null);
      setSnap(null);
      setErr("");
      setName("");
    }
  }, [open]);

  const send = async (f: File) => {
    setErr("");
    setSending(0);
    try {
      const u: Upload = await upload(`/api/ui/imports?name=${encodeURIComponent(f.name)}`, f, { "Content-Type": "application/octet-stream" }, setSending);
      setFile(u);
      invalidate("ui-imports");
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setSending(null);
      if (input.current) input.current.value = "";
    }
  };

  const nameBad = name !== "" && !nameRe.test(name);
  const p = plan.data;
  const ok = !!chosen && !!p && p.blockers.length === 0 && !!project && !nameBad && !busy;

  const submit = async () => {
    if (!ok) return;
    setBusy(true);
    setErr("");
    try {
      await ui(`${chosen!.base}/run`, { method: "POST", body: { server: srv, project, name, network, pool: storage, keep_mac: keepMAC, start, ...chosen!.extra } });
      invalidate("ui-jobs");
      invalidate("ui-imports");
      app.toast(`Importing ${p!.name} on the server. You can close this page; follow it under Tasks.`);
      onClose();
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  const drop = async (u: Upload) => {
    await ui(`/imports/${u.id}`, { method: "DELETE" }).catch(() => {});
    if (file?.id === u.id) setFile(null);
    invalidate("ui-imports");
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      dirty={sending != null}
      title="Import"
      head={head}
      wide
      footer={
        <>
          <span className="dim l" style={{ fontSize: 12.5 }}>
            {chosen ? chosen.label : from === "file" ? "Upload a vzdump backup first" : "Pick a backup first"}
          </span>
          <button className="btn btn-s press" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-p press" onClick={submit} disabled={!ok}>
            {busy ? "Starting…" : "Import"}
          </button>
        </>
      }
    >
      {err && (
        <div className="cerr stick" role="alert">
          {err}
        </div>
      )}
      <SheetSec title="1. Choose the backup">
        <Seg
          value={from}
          onChange={setFrom}
          label="Backup from"
          options={[
            { v: "file", l: "Upload a file" },
            { v: "pbs", l: "Proxmox Backup Server" },
          ]}
        />
        {from === "pbs" ? (
          <PBSPicker servers={pbsList.data} admin={app.admin} pbs={pbs} setPbs={(n) => (setPbsName(n), setSnap(null))} snaps={snaps} snap={snap} setSnap={setSnap} />
        ) : (
          <>
            <p className="dim" style={{ margin: "10px 0 0" }}>
              A vzdump file from Proxmox: <code>vzdump-qemu-*.vma</code> for a VM or <code>vzdump-lxc-*.tar</code> for a container, plain or compressed with zstd or gzip. Proxmox keeps them under <code>/var/lib/vz/dump</code>.
            </p>
            <p className="dim" style={{ margin: "8px 0 0" }}>
              Your browser sends the file to the UI server. Keep this page open until the upload is done. After that the browser isn't needed anymore.
            </p>
            <div className="imp-up">
              <input ref={input} type="file" hidden accept=".vma,.zst,.gz,.tgz,.tar,.lzo" onChange={(e) => e.target.files?.[0] && send(e.target.files[0])} />
              <button className="btn btn-s press" disabled={sending != null} onClick={() => input.current?.click()}>
                {sending != null ? `Uploading ${Math.round(sending * 100)}%` : "Choose a file"}
              </button>
              {sending != null && (
                <div className="jbar" role="progressbar" aria-valuenow={Math.round(sending * 100)} aria-valuemin={0} aria-valuemax={100}>
                  <i style={{ transform: `scaleX(${Math.max(0.02, sending)})` }} />
                </div>
              )}
            </div>
            {(uploads.data || []).length > 0 && (
              <ul className="imp-list">
                {uploads.data!.map((u) => (
                  <li key={u.id} className={file?.id === u.id ? "on" : undefined}>
                    <button className="lnk" onClick={() => setFile(u)} aria-pressed={file?.id === u.id}>
                      {u.name}
                    </button>
                    <span className="dim">
                      {u.kind === "container" ? "container" : "VM"}, {bytes(u.size)}, on the server until {day(u.expires)}
                    </span>
                    <button className="lnk" onClick={() => drop(u)}>
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </SheetSec>

      {chosen && (
        <>
          <SheetSec title="2. Choose where it goes">
            <div className="two">
              <Field label="Name" hint={nameBad ? "Start with a letter; use letters, numbers and dashes." : "Leave empty to keep the Proxmox name."} bad={nameBad}>
                <Input value={name} onChange={setName} placeholder={p?.name || ""} bad={nameBad} />
              </Field>
              {servers.length > 1 && (
                <Field label="Server">
                  <Select value={srv} onChange={setServer} options={servers.map((s) => s.name)} />
                </Field>
              )}
              <Field label="Project" hint={!project ? "You need the manager role on a project to import into it." : ""} bad={!project}>
                <Select value={project} onChange={setProj} options={(projects.data || []).filter((x) => app.can(srv, x, "manager")).map((x) => ({ v: x, l: x }))} aria-label="Project" />
              </Field>
              <Field label="Network">
                <Select value={network} onChange={setNet} options={(nets.data || []).map((n) => n.name)} />
              </Field>
              <Field label="Storage pool">
                <Select value={storage} onChange={setPool} options={pools.data || []} />
              </Field>
            </div>
            <TglRow title="Keep the MAC address" note="The guest keeps its DHCP reservations and its network interface names." on={keepMAC} onChange={setKeepMAC} />
            <TglRow title="Start after the import" note="The import waits up to 3 minutes for a network address." on={start} onChange={setStart} />
          </SheetSec>

          <SheetSec title="3. Check what it becomes">
            <p className="dim" style={{ margin: 0 }}>
              The import runs on the UI server. Once it has started you can close the browser: it keeps going and shows under Tasks.{from === "file" && " The uploaded file is deleted when the import is done."}
            </p>
            {plan.error && <p className="bad">{friendlyError(plan.error)}</p>}
            {!p && !plan.error && <p className="dim">Reading the backup…</p>}
            {p && <PlanView p={p} />}
          </SheetSec>
        </>
      )}
    </Sheet>
  );
}

function PBSPicker(props: {
  servers?: { name: string; datastore: string }[];
  admin: boolean;
  pbs: string;
  setPbs: (n: string) => void;
  snaps: { data?: Snap[]; error?: any };
  snap: Snap | null;
  setSnap: (s: Snap) => void;
}) {
  const { servers, pbs, snaps, snap } = props;
  if (!servers) return null;
  if (servers.length === 0) {
    return (
      <p className="dim" style={{ margin: "10px 0 0" }}>
        {props.admin ? "Add a Proxmox Backup Server under Settings, Backups first." : "No Proxmox Backup Server is set up. Ask an admin to add one."}
      </p>
    );
  }
  return (
    <>
      <p className="dim" style={{ margin: "10px 0 0" }}>
        The UI server downloads the backup from PBS itself, so nothing goes through your browser.
      </p>
      {servers.length > 1 && (
        <Field label="Backup server">
          <Select value={pbs} onChange={props.setPbs} options={servers.map((x) => ({ v: x.name, l: `${x.name} (${x.datastore})` }))} />
        </Field>
      )}
      {snaps.error && <p className="bad">{friendlyError(snaps.error)}</p>}
      {!snaps.data && !snaps.error && <p className="dim">Loading backups…</p>}
      {snaps.data?.length === 0 && <p className="dim">No VM or container backups in this datastore.</p>}
      {!!snaps.data?.length && (
        <ul className="imp-list">
          {snaps.data.map((x) => (
            <li key={x.ref} className={snap?.ref === x.ref ? "on" : undefined}>
              <button className="lnk" disabled={!!x.problem} onClick={() => props.setSnap(x)} aria-pressed={snap?.ref === x.ref}>
                {x.kind === "container" ? "CT" : "VM"} {x.id}
                {x.comment ? ` ${x.comment}` : ""}
              </button>
              <span className="dim">
                {dateTime(x.created)}
                {x.size ? `, ${bytes(x.size)}` : ""}
                {x.problem ? `. ${x.problem}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function PlanView({ p }: { p: Plan }) {
  const mem = p.config["limits.memory"];
  const nics = Object.entries(p.devices).filter(([, d]) => d.type === "nic");
  const rows: [string, string][] = [
    ["Type", p.type === "container" ? "Container" : "Virtual machine"],
    ["Name", p.name],
    ["CPU", `${p.config["limits.cpu"] || "1"} cores`],
    ["Memory", mem ? bytes(memBytes(mem) ?? 0) : "default"],
    ["Root disk", p.disk_size ? bytes(p.disk_size) : "default"],
  ];
  for (const d of p.extra_disks || []) rows.push([`Disk ${d.key}`, `${bytes(d.size)}, as a custom volume`]);
  for (const [k, d] of nics) rows.push([`Network ${k}`, `${d.network}${d.hwaddr ? `, MAC ${d.hwaddr}` : ""}`]);
  if (p.type !== "container") {
    rows.push(["Firmware", p.config["security.csm"] === "true" ? "Legacy BIOS (SeaBIOS)" : p.config["security.secureboot"] === "true" ? "UEFI with Secure Boot" : "UEFI"]);
  }
  if (p.config["boot.autostart"] === "true") rows.push(["Autostart", "Yes"]);
  return (
    <>
      <dl className="imp-plan">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {p.blockers.length > 0 && (
        <div className="cerr" role="alert">
          This backup can't be imported: {p.blockers.join(" ")}
        </div>
      )}
      {p.warnings.length > 0 && (
        <ul className="imp-warn">
          {p.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
    </>
  );
}

// ---------- Docker Compose ----------

type ComposeService = { service: string; name: string; server: string; image: string; config: Record<string, string>; devices: Record<string, Record<string, string>>; depends_on?: string[] };
type ComposePlan = { stack: string; services: ComposeService[]; volumes: string[]; warnings: string[]; blockers: string[] };

function ComposeSheet({ open, onClose, head }: { open: boolean; onClose: () => void; head: React.ReactNode }) {
  const app = useApp();
  const servers = useScopedServers().filter((s) => app.can(s.name, "*", "manager"));
  const [server, setServer] = useState("");
  const srv = server || servers[0]?.name || "";
  const projects = useNames(open ? srv : "", "projects");
  const [proj, setProj] = useState("");
  const newProject = proj === "" && app.admin;
  const project = proj || (app.admin ? "" : (projects.data || []).find((p) => app.can(srv, p, "manager")) || "");
  const pools = useNames(open ? srv : "", "storage-pools", project || "default");
  const [pool, setPool] = useState("");
  const storage = pool || (pools.data?.includes("default") ? "default" : pools.data?.[0]) || "";
  const [text, setText] = useState("");
  const [env, setEnv] = useState("");
  const [stack, setStack] = useState("");
  const [start, setStart] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const file = useRef<HTMLInputElement>(null);

  // Plan after the typing stops.
  const body = { server: srv, project, new_project: newProject, compose: text, env, stack, pool: storage, start };
  const key = JSON.stringify(body);
  const [planKey, setPlanKey] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setPlanKey(key), 500);
    return () => clearTimeout(t);
  }, [key]);
  const plan = useData<{ plan: ComposePlan; project: string }>(open && text.trim() && srv && planKey ? `compose-plan:${planKey}` : null, () => ui("/compose/plan", { method: "POST", body: JSON.parse(planKey) }));
  const p = plan.data?.plan;
  const ok = !!p && p.blockers.length === 0 && planKey === key && !busy && (newProject || !!project);

  useEffect(() => {
    if (!open) {
      setText("");
      setEnv("");
      setErr("");
    }
  }, [open]);

  const submit = async () => {
    if (!ok) return;
    setBusy(true);
    setErr("");
    try {
      await ui("/compose/run", { method: "POST", body });
      invalidate("ui-jobs");
      app.toast(`Importing stack ${p!.stack}. Follow it under Tasks.`);
      onClose();
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  const projOpts = [...(app.admin ? [{ v: "", l: `New project ${stack || plan.data?.plan.stack || ""}`.trim() }] : []), ...(projects.data || []).filter((x) => app.can(srv, x, "manager")).map((x) => ({ v: x, l: x }))];
  return (
    <Sheet
      open={open}
      onClose={onClose}
      dirty={!!text}
      title="Import"
      head={head}
      wide
      footer={
        <>
          <span className="dim l" style={{ fontSize: 12.5 }}>
            {p ? `${p.services.length} service${p.services.length === 1 ? "" : "s"} into ${plan.data!.project}` : "Paste a compose file first"}
          </span>
          <button className="btn btn-s press" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-p press" onClick={submit} disabled={!ok}>
            {busy ? "Starting…" : "Import"}
          </button>
        </>
      }
    >
      {err && (
        <div className="cerr stick" role="alert">
          {err}
        </div>
      )}
      <SheetSec
        title="Compose file"
        action={
          <>
            <input
              ref={file}
              type="file"
              hidden
              accept=".yml,.yaml"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) setText(await f.text());
                e.target.value = "";
              }}
            />
            <button type="button" className="btn btn-q btn-sm" onClick={() => file.current?.click()}>
              Open a file
            </button>
          </>
        }
      >
        <p className="dim" style={{ margin: 0 }}>
          Each service becomes an Incus application container that runs the same image. Ports become proxy devices on this server, named volumes become storage volumes. Volume data and host folders don't move: copy them in after the import.
        </p>
        <textarea className="yaml box" spellCheck={false} aria-label="Compose file" placeholder={"services:\n  web:\n    image: nginx\n    ports: [\"8080:80\"]"} value={text} onChange={(e) => setText(e.target.value)} />
        <Field label="Environment variables" hint="The contents of the .env file next to the compose file, if it has one.">
          <textarea className="yaml box env" spellCheck={false} aria-label="Environment variables" placeholder="DB_PASSWORD=..." value={env} onChange={(e) => setEnv(e.target.value)} />
        </Field>
      </SheetSec>

      <SheetSec title="Where">
        <div className="two">
          <Field label="Stack name" hint="Names the volumes, and the project when it's new.">
            <Input value={stack} onChange={setStack} placeholder={p?.stack || "stack"} />
          </Field>
          {servers.length > 1 && (
            <Field label="Server">
              <Select value={srv} onChange={setServer} options={servers.map((s) => s.name)} />
            </Field>
          )}
          <Field label="Project">
            <Select value={proj} onChange={setProj} options={projOpts} aria-label="Project" />
          </Field>
          <Field label="Storage pool">
            <Select value={storage} onChange={setPool} options={pools.data || []} />
          </Field>
        </div>
        <TglRow title="Start after the import" on={start} onChange={setStart} />
      </SheetSec>

      {text.trim() && (
        <SheetSec title="What it becomes">
          {plan.error && <p className="bad">{friendlyError(plan.error)}</p>}
          {!p && !plan.error && <p className="dim">Reading the file…</p>}
          {p && <ComposeView p={p} />}
        </SheetSec>
      )}
    </Sheet>
  );
}

function ComposeView({ p }: { p: ComposePlan }) {
  return (
    <>
      <div className="imp-svcs">
        {p.services.map((s) => {
          const ports = Object.values(s.devices)
            .filter((d) => d.type === "proxy")
            .map((d) => d.listen.split(":").slice(-1)[0] + (d.listen.startsWith("udp") ? "/udp" : ""));
          const vols = Object.values(s.devices).filter((d) => d.type === "disk");
          return (
            <div key={s.name} className="imp-svc">
              <div>
                <b>{s.name}</b> <span className="mono dim">{s.server.replace("https://", "") + "/" + s.image}</span>
              </div>
              <div className="dim">
                {[ports.length ? `ports ${ports.join(", ")}` : "", vols.length ? vols.map((v) => `${v.source} at ${v.path}`).join(", ") : "", s.depends_on?.length ? `after ${s.depends_on.join(", ")}` : ""].filter(Boolean).join(" · ") || "no ports or volumes"}
              </div>
            </div>
          );
        })}
      </div>
      {p.blockers.length > 0 && (
        <div className="cerr" role="alert">
          This file can't be imported: {p.blockers.join(" ")}
        </div>
      )}
      {p.warnings.length > 0 && (
        <ul className="imp-warn">
          {p.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
    </>
  );
}
