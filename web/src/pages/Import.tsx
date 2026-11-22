import { useEffect, useRef, useState } from "react";
import { bytes, friendlyError, memBytes, ui, upload } from "../api";
import { invalidate, useApp, useData, useScopedServers } from "../state";
import { useManagedNetworks, useNames } from "../data";
import { Field, Input, Select, Sheet, SheetSec, TglRow } from "../ui";

type Upload = { id: string; name: string; kind: "container" | "virtual-machine"; size: number; created: string };
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

// Import a Proxmox vzdump backup: upload it, check what it becomes, import.
export function ImportSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const app = useApp();
  const servers = useScopedServers().filter((s) => app.can(s.name, "*", "manager"));
  const uploads = useData<Upload[]>(open ? "ui-imports" : null, () => ui("/imports"));
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

  const qs = new URLSearchParams({ network, pool: storage, name, keep_mac: String(keepMAC) });
  const plan = useData<Plan>(file && network && storage ? `import-plan:${file.id}:${qs}` : null, () => ui(`/imports/${file!.id}/plan?${qs}`));

  useEffect(() => {
    if (!open) {
      setFile(null);
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
  const ok = !!file && !!p && p.blockers.length === 0 && !!project && !nameBad && !busy;

  const submit = async () => {
    if (!ok) return;
    setBusy(true);
    setErr("");
    try {
      await ui(`/imports/${file!.id}/run`, { method: "POST", body: { server: srv, project, name, network, pool: storage, keep_mac: keepMAC, start } });
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

  return (
    <Sheet
      open={open}
      onClose={onClose}
      dirty={sending != null}
      title="Import from Proxmox"
      wide
      footer={
        <>
          <span className="dim l" style={{ fontSize: 12.5 }}>
            {file ? `${file.name}, ${bytes(file.size)}` : "Upload a vzdump backup first"}
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
      <SheetSec title="Backup">
        <p className="dim" style={{ margin: 0 }}>
          A vzdump file from Proxmox: <code>vzdump-qemu-*.vma</code> for a VM or <code>vzdump-lxc-*.tar</code> for a container, plain or compressed with zstd or gzip. Proxmox keeps them under <code>/var/lib/vz/dump</code>.
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
                  {u.kind === "container" ? "container" : "VM"}, {bytes(u.size)}
                </span>
                <button className="lnk" onClick={() => drop(u)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </SheetSec>

      {file && (
        <>
          <SheetSec title="Where">
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

          <SheetSec title="What it becomes">
            {plan.error && <p className="bad">{friendlyError(plan.error)}</p>}
            {!p && !plan.error && <p className="dim">Reading the backup…</p>}
            {p && <PlanView p={p} />}
          </SheetSec>
        </>
      )}
    </Sheet>
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
