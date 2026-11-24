import { useEffect, useMemo, useRef, useState } from "react";
import { bytes, dateTime, friendlyError, memBytes, ui, upload } from "../api";
import { ic } from "../icons";
import { invalidate, useApp, useData, useScopedServers } from "../state";
import { useManagedNetworks, useNames } from "../data";
import { Field, Input, Seg, Select, Sheet, SheetSec, Skel, TglRow } from "../ui";

type Upload = { id: string; name: string; kind: "container" | "virtual-machine"; size: number; created: string; expires: string };

type Snap = { ref: string; kind: "container" | "virtual-machine"; id: string; created: string; comment?: string; size?: number; problem?: string };

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
  const [state, setState] = useState<{ dirty: boolean; footer: React.ReactNode }>({ dirty: false, footer: null });
  const head = <Seg value={kind} onChange={setKind} label="Import from" options={[{ v: "proxmox", l: "Proxmox" }, { v: "compose", l: "Docker Compose" }]} />;
  return (
    <Sheet open={open} onClose={onClose} dirty={state.dirty} title="Import" head={head} wide footer={state.footer}>
      {kind === "proxmox" ? <ProxmoxBody open={open} onClose={onClose} setSheet={setState} /> : <ComposeBody open={open} onClose={onClose} setSheet={setState} />}
    </Sheet>
  );
}

function ProxmoxBody({ open, onClose, setSheet }: { open: boolean; onClose: () => void; setSheet: (s: { dirty: boolean; footer: React.ReactNode }) => void }) {
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
      : snap && { label: `${snap.kind === "container" ? "CT" : "VM"} ${snap.id} from ${dateTime(snap.created)}, on ${pbs}`, base: `/pbs/${encodeURIComponent(pbs)}`, extra: { snap: snap.ref } as Record<string, string> };
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
      app.toast(`Importing ${p!.name}. Follow it under Tasks.`);
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

  const chosenLabel = chosen?.label || "";
  useEffect(() => {
    setSheet({
      dirty: sending != null,
      footer: (
        <>
          <span className="dim l" style={{ fontSize: 12.5 }}>
            {chosenLabel || (from === "file" ? "Upload a vzdump backup first" : "Pick a backup first")}
          </span>
          <button className="btn btn-s press" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-p press" onClick={submit} disabled={!ok}>
            {busy ? "Starting…" : "Import"}
          </button>
        </>
      ),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sending != null, chosenLabel, from, ok, busy]);

  return (
    <>
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
          <PBSPicker servers={pbsList.data} error={pbsList.error} admin={app.admin} pbs={pbs} setPbs={(n) => (setPbsName(n), setSnap(null))} snaps={snaps} snap={snap} setSnap={setSnap} />
        ) : (
          <>
            <p className="dim" style={{ margin: "10px 0 0" }}>
              A vzdump file from Proxmox: <span className="mono">vzdump-qemu-*.vma</span> for a VM or <span className="mono">vzdump-lxc-*.tar</span> for a container, plain or compressed with zstd or gzip. Proxmox keeps them under <span className="mono">/var/lib/vz/dump</span>.
            </p>
            <p className="dim" style={{ margin: "8px 0 0" }}>
              Your browser sends the file to the UI server. Keep this page open until the upload is done. After that the browser isn't needed anymore.
            </p>
            <div
              className="drop slim"
              onClick={() => sending == null && input.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (sending == null && e.dataTransfer.files[0]) send(e.dataTransfer.files[0]);
              }}
            >
              {ic.up}
              <b>{sending != null ? `Uploading ${Math.round(sending * 100)}%` : "Drop a vzdump file here or click to choose"}</b>
              <span className="dim">.vma, .tar, .tgz, .zst, .gz or .lzo</span>
              <input ref={input} type="file" hidden accept=".vma,.zst,.gz,.tgz,.tar,.lzo" onChange={(e) => e.target.files?.[0] && send(e.target.files[0])} />
            </div>
            {sending != null && (
              <div className="prog" role="progressbar" aria-valuenow={Math.round(sending * 100)} aria-valuemin={0} aria-valuemax={100}>
                <i style={{ transform: `scaleX(${Math.max(0.02, sending)})` }} />
              </div>
            )}
            {(uploads.data || []).length > 0 && (
              <div className="ilinks">
                {uploads.data!.map((u) => (
                  <div key={u.id} style={{ display: "flex", alignItems: "center", gap: 6, borderTop: "1px solid var(--line)" }} className="imp-iopt-row">
                    <button type="button" className="iopt" style={{ flex: 1, minWidth: 0 }} aria-selected={file?.id === u.id} onClick={() => setFile(u)}>
                      <span className="os">
                        {u.name}
                        <small>
                          {u.kind === "container" ? "container" : "VM"}, {bytes(u.size)}, deleted {dateTime(u.expires)}
                        </small>
                      </span>
                    </button>
                    <button type="button" className="btn btn-q btn-sm" style={{ marginRight: 6 }} onClick={() => drop(u)}>
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}
            {(uploads.data || []).length > 0 && (
              <p className="dim" style={{ margin: "8px 0 0", fontSize: 12.5 }}>
                These uploads take {bytes(uploads.data!.reduce((n, u) => n + u.size, 0))} on the UI server. Each one is deleted when its import is done, or a day after it was uploaded or last imported.
              </p>
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
            {plan.error && <div className="note-box bad">{friendlyError(plan.error)}</div>}
            {!p && !plan.error && <Skel lines={2} />}
            {p && <PlanView p={p} />}
          </SheetSec>
        </>
      )}
    </>
  );
}

function PBSPicker(props: {
  servers?: { name: string; datastore: string }[];
  error?: any;
  admin: boolean;
  pbs: string;
  setPbs: (n: string) => void;
  snaps: { data?: Snap[]; error?: any };
  snap: Snap | null;
  setSnap: (s: Snap) => void;
}) {
  const { servers, pbs, snaps, snap } = props;
  if (props.error) return <div className="note-box bad">{friendlyError(props.error)}</div>;
  if (!servers) return <Skel lines={2} />;
  if (!props.admin) {
    return (
      <p className="dim" style={{ margin: "10px 0 0" }}>
        Only admins can import from a Proxmox Backup Server: a datastore holds the backups of every guest. Ask an admin, or upload a vzdump file instead.
      </p>
    );
  }
  if (servers.length === 0) {
    return (
      <p className="dim" style={{ margin: "10px 0 0" }}>
        Add a Proxmox Backup Server under Settings, Backups first.
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
      {snaps.error && <div className="note-box bad">{friendlyError(snaps.error)}</div>}
      {!snaps.data && !snaps.error && <Skel lines={2} />}
      {snaps.data?.length === 0 && <p className="dim">No VM or container backups in this datastore.</p>}
      {!!snaps.data?.length && <PBSGuests snaps={snaps.data} snap={snap} setSnap={props.setSnap} />}
    </>
  );
}

// PBSGuests lists the backups per guest, in Proxmox's order (by ID). A
// guest opens to show its backups, newest first; opening it picks the
// newest one that can be imported.
function PBSGuests({ snaps, snap, setSnap }: { snaps: Snap[]; snap: Snap | null; setSnap: (s: Snap) => void }) {
  const guests = useMemo(() => {
    const m = new Map<string, Snap[]>();
    for (const s of snaps) {
      const k = `${s.kind}/${s.id}`;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(s);
    }
    const time = (s: Snap) => Date.parse(s.created) || 0;
    for (const l of m.values()) l.sort((a, b) => time(b) - time(a));
    const num = (id: string) => (/^\d+$/.test(id) ? Number(id) : Infinity);
    return [...m.entries()].sort(([, a], [, b]) => num(a[0].id) - num(b[0].id) || a[0].id.localeCompare(b[0].id) || a[0].kind.localeCompare(b[0].kind));
  }, [snaps]);
  const [open, setOpen] = useState(() => (snap ? `${snap.kind}/${snap.id}` : ""));
  return (
    <ul className="pbs-guests">
      {guests.map(([key, list]) => {
        const head = list[0];
        const name = list.find((x) => x.comment)?.comment;
        const isOpen = open === key;
        const usable = list.filter((x) => !x.problem);
        return (
          <li key={key} className={isOpen ? "open" : undefined}>
            <button
              className="pbs-g"
              aria-expanded={isOpen}
              onClick={() => {
                setOpen(isOpen ? "" : key);
                if (!isOpen && usable[0] && !list.some((x) => x.ref === snap?.ref)) setSnap(usable[0]);
              }}
            >
              <span className="k">{head.kind === "container" ? "CT" : "VM"}</span>
              <span className="id">{head.id}</span>
              <span className="n">{name || "–"}</span>
              <span className="m">
                {list.length === 1 ? "1 backup" : `${list.length} backups`}, newest {dateTime(head.created)}
              </span>
            </button>
            {isOpen && (
              <div className="pbs-snaps" style={{ padding: 4 }}>
                {list.map((x) => (
                  <button
                    type="button"
                    key={x.ref}
                    className="iopt"
                    disabled={!!x.problem}
                    aria-selected={snap?.ref === x.ref}
                    onClick={() => setSnap(x)}
                  >
                    <span className="os">
                      {dateTime(x.created)}
                      {x.size ? <small>{bytes(x.size)}</small> : null}
                      {x.problem && <small className="bad">{x.problem}</small>}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </li>
        );
      })}
    </ul>
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
      <dl className="kv tight">
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: "contents" }}>
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
        <ul className="wlist">
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

function ComposeBody({ open, onClose, setSheet }: { open: boolean; onClose: () => void; setSheet: (s: { dirty: boolean; footer: React.ReactNode }) => void }) {
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
  const summary = p ? `${p.services.length} service${p.services.length === 1 ? "" : "s"} into ${plan.data!.project}` : "";
  useEffect(() => {
    setSheet({
      dirty: !!text,
      footer: (
        <>
          <span className="dim l" style={{ fontSize: 12.5 }}>
            {summary || "Paste a compose file first"}
          </span>
          <button className="btn btn-s press" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-p press" onClick={submit} disabled={!ok}>
            {busy ? "Starting…" : "Import"}
          </button>
        </>
      ),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!text, summary, ok, busy]);

  return (
    <>
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
          {plan.error && <div className="note-box bad">{friendlyError(plan.error)}</div>}
          {!p && !plan.error && <Skel lines={2} />}
          {p && <ComposeView p={p} />}
        </SheetSec>
      )}
    </>
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
        <ul className="wlist">
          {p.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
    </>
  );
}
