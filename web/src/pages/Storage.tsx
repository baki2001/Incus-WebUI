import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { bytes, dateTime, incus, incusOp, incusURL, parseBytes, upload, waitOp } from "../api";
import { ic } from "../icons";
import { useCrumbs } from "../Shell";
import { invalidate, useApp, useData, useScopedServers } from "../state";
import { listVolumes, useCollection, useCurrentProject, useInstances, useNames } from "../data";
import { CopyBtn, confirmDialog, Field, Input, KVEditor, Seg, Select, Sheet, SheetSec, Table, type Col } from "../ui";
import { EditSheet, matches, PageHead, Search, UsedBy } from "./Resource";
import { NameCell } from "./Networks";
import { parseUsed } from "./usedby";

type Pool = { name: string; driver: string; description: string; status: string; config: Record<string, string>; used_by: string[]; server: string };
type PoolPut = { name?: string; driver?: string; description: string; config: Record<string, string> };
type Vol = { name: string; pool: string; type: string; content_type: string; description: string; config: Record<string, string>; used_by: string[]; created_at: string; location: string; project: string; server: string };

const serverCol = <T extends { server: string }>(multi: boolean): Col<T> => ({ k: "server", label: "Server", cell: (r) => r.server, sort: (r) => r.server, hide: !multi, cls: "hide-m" });

// What an Incus "used by" URL points at, with a link to where you manage it.
function usedRef(u: string, server: string) {
  const it = parseUsed(u, server);
  return { kind: it.res, label: it.kind, name: it.name, project: it.project, to: it.res === "storage-pools" ? "/storage/volumes" : it.to || "" };
}

// Everything that uses an object, as links. Shown wherever it decides whether a delete can work.
function UsedList({ list, server, detach }: { list?: string[]; server: string; detach?: (kind: string, name: string, project: string) => void }) {
  if (!list?.length) return <span className="dim">Nothing</span>;
  return (
    <span className="ulist">
      {list.map((u) => {
        const r = usedRef(u, server);
        return (
          <span key={u} className="ul-r">
            {r.to ? <Link to={r.to}>{r.name}</Link> : <span>{r.name}</span>}
            <small className="dim">
              {r.label.toLowerCase()}
              {r.project !== "default" && r.kind === "instances" ? ` in ${r.project}` : ""}
            </small>
            {detach && (r.kind === "instances" || r.kind === "profiles") && (
              <button type="button" className="btn btn-q btn-sm press" onClick={() => detach(r.kind, r.name, r.project)}>
                Detach
              </button>
            )}
          </span>
        );
      })}
    </span>
  );
}

const poolKeys = ["source", "size", "zfs.pool_name", "btrfs.mount_options", "lvm.vg_name", "lvm.thinpool_name", "volume.size", "volume.block.filesystem", "rsync.bwlimit"];

// ---------- pools ----------

export function Pools() {
  useCrumbs([{ label: "Storage" }, { label: "Pools" }]);
  const app = useApp();
  const project = useCurrentProject();
  const servers = useScopedServers();
  const multi = app.servers.length > 1;
  const q = useCollection<Pool>("pools", "/1.0/storage-pools?recursion=1");
  const space = useData<Record<string, { used: number; total: number }>>(q.data ? `pool-space:${q.data.map((p) => p.server + p.name).join(",")}` : null, async () => {
    const out: Record<string, { used: number; total: number }> = {};
    await Promise.all(
      (q.data || []).map(async (p) => {
        const r = await incus<any>(p.server, `/1.0/storage-pools/${encodeURIComponent(p.name)}/resources`).catch(() => null);
        if (r?.space) out[p.server + "/" + p.name] = { used: r.space.used || 0, total: r.space.total || 0 };
      }),
    );
    return out;
  });
  const [search, setSearch] = useState("");
  const [edit, setEdit] = useState<Pool | null>(null);
  const [create, setCreate] = useState(false);
  const [server, setServer] = useState("");
  const srv = edit?.server || server || servers[0]?.name || "";
  const info = useData<any>(create && srv ? `server-info:${srv}` : null, () => incus(srv, "/1.0"));
  const drivers: string[] = (info.data?.environment?.storage_supported_drivers || []).map((d: any) => d.Name || d.name).filter((d: string) => d !== "cephobject" || true);

  const save = async (d: PoolPut) => {
    if (!edit) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(d.name || "")) return void app.toast("Give the pool a name.");
      const body = { ...d, config: Object.fromEntries(Object.entries(d.config).filter(([k, v]) => k && v !== "")) };
      const ok = await app.run(`Creating pool ${d.name}`, (p) => incusOp(srv, "/1.0/storage-pools", { method: "POST", body }, p).then(() => true), `Pool ${d.name} created`);
      if (ok) invalidate("pools:");
      return ok;
    }
    const ok = await app.run(`Saving ${edit.name}`, () => incusOp(edit.server, `/1.0/storage-pools/${encodeURIComponent(edit.name)}`, { method: "PUT", body: { description: d.description, config: d.config } }).then(() => true), `Pool ${edit.name} saved`);
    if (ok) invalidate("pools:");
    return ok;
  };
  const del = async (p: Pool) => {
    if (!(await confirmDialog({ title: `Delete pool ${p.name}?`, body: p.used_by?.length ? (
        <>
          Incus refuses while these use it. Remove or move them first.
          <UsedList list={p.used_by} server={p.server} />
        </>
      ) : (
        "The pool and its data are removed."
      ), confirm: "Delete", danger: true, typeToConfirm: p.name }))) return;
    const ok = await app.run(`Deleting ${p.name}`, () => incusOp(p.server, `/1.0/storage-pools/${encodeURIComponent(p.name)}`, { method: "DELETE" }).then(() => true), `Pool ${p.name} deleted`);
    if (ok) {
      setEdit(null);
      invalidate("pools:");
    }
  };

  return (
    <>
      <PageHead title="Storage pools">
        <button className="btn btn-p press" onClick={() => setCreate(true)}>
          {ic.plus}Create pool
        </button>
      </PageHead>
      <div className="fbar">
        <Search value={search} onChange={setSearch} placeholder="Filter by name or driver" />
        {project !== "default" && <span className="dim fnote">Pools belong to the server, not to a project.</span>}
      </div>
      <Table<Pool>
        rows={q.data?.filter((p) => matches(search, p.name, p.driver, p.description))}
        loading={q.loading}
        rowKey={(p) => p.server + p.name}
        onRow={setEdit}
        empty={q.error || "No storage pools."}
        cols={[
          { k: "name", label: "Pool", sort: (p) => p.name, cell: (p) => <NameCell name={p.name} sub={p.description} /> },
          { k: "driver", label: "Driver", sort: (p) => p.driver, cell: (p) => <span className="mono">{p.driver}</span> },
          serverCol<Pool>(multi),
          {
            k: "space",
            label: "Space",
            sort: (p) => space.data?.[p.server + "/" + p.name]?.used ?? -1,
            cls: "hide-s",
            cell: (p) => {
              const s = space.data?.[p.server + "/" + p.name];
              if (!s) return <span className="dim">–</span>;
              return (
                <div className="metric" style={{ minWidth: 150 }}>
                  <small>
                    <span className="v">{bytes(s.used)}</span>
                    <span className="dim">of {bytes(s.total, 0)}</span>
                  </small>
                  <div className="bar">
                    <i style={{ transform: `scaleX(${s.total ? Math.min(1, s.used / s.total) : 0})` }} className={s.total && s.used / s.total > 0.9 ? "hot" : ""} />
                  </div>
                </div>
              );
            },
          },
          { k: "status", label: "State", sort: (p) => p.status, cell: (p) => <span className={"st " + (p.status === "Created" ? "running" : "error")}>{p.status}</span>, cls: "hide-s" },
          { k: "used", label: "Used by", sort: (p) => p.used_by?.length || 0, cell: (p) => <UsedBy list={p.used_by} />, cls: "right" },
        ]}
      />
      <EditSheet<PoolPut>
        open={create || !!edit}
        onClose={() => (setCreate(false), setEdit(null))}
        title={edit ? `Pool ${edit.name}` : "Create storage pool"}
        create={!edit}
        value={edit ? { description: edit.description, config: edit.config } : create ? { name: "", driver: "dir", description: "", config: {} } : null}
        onSave={save}
        onDelete={edit ? () => del(edit) : undefined}
        info={
          edit && (
            <dl className="kv tight">
              <dt>Driver</dt>
              <dd className="mono">{edit.driver}</dd>
              <dt>Source</dt>
              <dd className="mono">{edit.config.source || "–"}</dd>
              {space.data?.[edit.server + "/" + edit.name] && (
                <>
                  <dt>Space</dt>
                  <dd>
                    {bytes(space.data[edit.server + "/" + edit.name].used)} used of {bytes(space.data[edit.server + "/" + edit.name].total)}
                  </dd>
                </>
              )}
            </dl>
          )
        }
        form={(d, set) => (
          <>
            {!edit && (
              <>
                <div className="two">
                  <Field label="Name">
                    <Input autoFocus mono value={d.name || ""} onChange={(v) => set((x) => void (x.name = v))} placeholder="fast" />
                  </Field>
                  {servers.length > 1 ? (
                    <Field label="Server">
                      <Select value={srv} onChange={setServer} options={servers.map((s) => s.name)} />
                    </Field>
                  ) : (
                    <Field label="Driver">
                      <Select value={d.driver || "dir"} onChange={(v) => set((x) => void (x.driver = v))} options={drivers.length ? drivers : ["dir", "zfs", "btrfs", "lvm"]} />
                    </Field>
                  )}
                </div>
                {servers.length > 1 && (
                  <Field label="Driver">
                    <Select value={d.driver || "dir"} onChange={(v) => set((x) => void (x.driver = v))} options={drivers.length ? drivers : ["dir", "zfs", "btrfs", "lvm"]} />
                  </Field>
                )}
                <div className="two">
                  <Field label="Source" hint={d.driver === "dir" ? "A folder on the host. Empty makes one." : "A disk, partition or existing pool. Empty makes a loop file."}>
                    <Input mono value={d.config.source || ""} onChange={(v) => set((x) => (v ? (x.config.source = v) : delete x.config.source))} placeholder={d.driver === "dir" ? "/srv/incus" : "/dev/sdb"} />
                  </Field>
                  {d.driver !== "dir" && (
                    <Field label="Size" hint="For a loop file, like 50GiB.">
                      <Input mono value={d.config.size || ""} onChange={(v) => set((x) => (v ? (x.config.size = v) : delete x.config.size))} placeholder="30GiB" />
                    </Field>
                  )}
                </div>
              </>
            )}
            <Field label="Description">
              <Input value={d.description} onChange={(v) => set((x) => void (x.description = v))} />
            </Field>
            <SheetSec title="All settings">
              <KVEditor value={d.config} onChange={(c) => set((x) => void (x.config = c))} keys={poolKeys} hide={(k) => k.startsWith("volatile.")} />
            </SheetSec>
          </>
        )}
      />
    </>
  );
}

// ---------- volumes ----------

function useVolumes(filter: (v: Vol) => boolean, key: string) {
  const project = useCurrentProject();
  const servers = useScopedServers();
  const names = servers.map((s) => s.name).join(",");
  const q = useData<Vol[]>(names ? `volumes:${names}:${project}` : null, async () => (await Promise.all(servers.map(async (s) => (await listVolumes<Vol>(s.name, project)).map((v) => ({ ...v, server: s.name }))))).flat());
  return { ...q, data: q.data?.filter(filter), key };
}

type VolPut = { name?: string; pool?: string; content_type?: string; description: string; config: Record<string, string> };

export function Volumes() {
  useCrumbs([{ label: "Storage" }, { label: "Volumes" }]);
  const app = useApp();
  const project = useCurrentProject();
  const servers = useScopedServers();
  const multi = app.servers.length > 1;
  const [kind, setKind] = useState<"custom" | "all">("custom");
  const q = useVolumes((v) => (kind === "all" || v.type === "custom") && v.content_type !== "iso" && !(v.type === "custom" && v.name.includes("/")), "vols");
  const [search, setSearch] = useState("");
  const [editKey, setEdit] = useState<Vol | null>(null);
  // Look the volume up again after every reload, so "Used by" stays current.
  const edit = (editKey && q.data?.find((v) => v.server === editKey.server && v.pool === editKey.pool && v.name === editKey.name)) || editKey;
  const state = useData<{ used: number; total: number } | null>(edit ? `vol-state:${edit.server}:${edit.pool}:${edit.name}:${project}` : null, async () => {
    const st = await incus<any>(edit!.server, volPath(edit!) + "/state", { project }).catch(() => null);
    return st?.usage ? { used: st.usage.used || 0, total: st.usage.total || 0 } : null;
  });
  const [create, setCreate] = useState(false);
  const [server, setServer] = useState("");
  const srv = edit?.server || server || servers[0]?.name || "";
  const pools = useNames(create ? srv : "", "storage-pools");
  const insts = useInstances();
  const [attach, setAttach] = useState({ inst: "", path: "/mnt/data" });
  const volPath = (v: Vol) => `/1.0/storage-pools/${encodeURIComponent(v.pool)}/volumes/${v.type}/${encodeURIComponent(v.name)}`;

  const save = async (d: VolPut) => {
    if (!edit) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(d.name || "")) return void app.toast("Give the volume a name.");
      const pool = d.pool || pools.data?.[0];
      const body = { name: d.name, content_type: d.content_type, description: d.description, config: Object.fromEntries(Object.entries(d.config).filter(([k, v]) => k && v !== "")) };
      const ok = await app.run(`Creating volume ${d.name}`, () => incusOp(srv, `/1.0/storage-pools/${encodeURIComponent(pool!)}/volumes/custom`, { method: "POST", project, body }).then(() => true), `Volume ${d.name} created`);
      if (ok) invalidate("volumes:");
      return ok;
    }
    const ok = await app.run(`Saving ${edit.name}`, () => incusOp(edit.server, volPath(edit), { method: "PUT", project, body: { description: d.description, config: d.config } }).then(() => true), `Volume ${edit.name} saved`);
    if (ok) invalidate("volumes:");
    return ok;
  };
  const del = async (v: Vol) => {
    if (!(await confirmDialog({ title: `Delete volume ${v.name}?`, body: v.used_by?.length ? (
        <>
          Incus refuses while it's attached. Detach it from these first.
          <UsedList list={v.used_by} server={v.server} />
        </>
      ) : (
        "Its data and snapshots are removed. This can't be undone."
      ), confirm: "Delete", danger: true, typeToConfirm: v.name }))) return;
    const ok = await app.run(`Deleting ${v.name}`, () => incusOp(v.server, volPath(v), { method: "DELETE", project }).then(() => true), `Volume ${v.name} deleted`);
    if (ok) {
      setEdit(null);
      invalidate("volumes:");
    }
  };
  const doDetach = async (v: Vol, kind: string, name: string, proj: string) => {
    const path = `/1.0/${kind}/${encodeURIComponent(name)}`;
    if (!(await confirmDialog({ title: `Detach ${v.name} from ${name}?`, body: "The data stays on the volume. A running VM may need a restart to let go of it.", confirm: "Detach" }))) return;
    const ok = await app.run(
      `Detaching ${v.name}`,
      async () => {
        const o = await incus<any>(v.server, path, { project: proj });
        const keys = Object.keys(o.devices || {}).filter((k) => o.devices[k].type === "disk" && o.devices[k].pool === v.pool && o.devices[k].source === v.name);
        if (!keys.length) throw new Error(`${name} gets this disk from a profile. Remove it from the profile instead.`);
        for (const k of keys) delete o.devices[k];
        const body = kind === "profiles" ? { description: o.description, config: o.config, devices: o.devices } : { architecture: o.architecture, config: o.config, devices: o.devices, ephemeral: o.ephemeral, profiles: o.profiles, stateful: o.stateful, description: o.description };
        await incusOp(v.server, path, { method: "PUT", project: proj, body });
        return true;
      },
      `${v.name} detached from ${name}`,
    );
    if (ok) {
      invalidate("volumes:");
      invalidate("instances:");
      invalidate("profiles:");
    }
  };
  const doAttach = async (v: Vol) => {
    const inst = insts.data?.find((i) => i.server === v.server && i.name === attach.inst);
    if (!inst) return;
    const dev = v.name.replace(/[^a-zA-Z0-9-]/g, "-");
    const body = { devices: { ...inst.devices, [dev]: { type: "disk", pool: v.pool, source: v.name, ...(v.content_type === "block" ? {} : { path: attach.path }) } } };
    const ok = await app.run(`Attaching ${v.name} to ${inst.name}`, () => incusOp(v.server, `/1.0/instances/${encodeURIComponent(inst.name)}`, { method: "PATCH", project: inst.project, body }).then(() => true), `${v.name} attached to ${inst.name}`);
    if (ok) {
      invalidate("volumes:");
      invalidate("instances:");
      setAttach({ ...attach, inst: "" });
    }
  };

  return (
    <>
      <PageHead title="Volumes">
        <button className="btn btn-p press" onClick={() => setCreate(true)}>
          {ic.plus}Create volume
        </button>
      </PageHead>
      <div className="fbar">
        <Search value={search} onChange={setSearch} placeholder="Filter by name or pool" />
        <Seg value={kind} onChange={setKind} label="Volume kind" options={[{ v: "custom", l: "Custom" }, { v: "all", l: "All, with instance disks" }]} />
      </div>
      <Table<Vol>
        rows={q.data?.filter((v) => matches(search, v.name, v.pool, v.description))}
        loading={q.loading}
        rowKey={(v) => v.server + v.pool + v.type + v.name}
        onRow={(v) => (v.type === "custom" ? setEdit(v) : undefined)}
        empty={q.error || (search ? "No volumes match." : "No custom volumes yet. They hold data that outlives an instance.")}
        cols={[
          { k: "name", label: "Name", sort: (v) => v.name, cell: (v) => <NameCell name={v.name} sub={v.description} /> },
          { k: "pool", label: "Pool", sort: (v) => v.pool, cell: (v) => v.pool },
          { k: "type", label: "Type", sort: (v) => v.type, cell: (v) => (v.type === "custom" ? v.content_type : v.type.replace("virtual-machine", "VM disk").replace("container", "container disk")) },
          serverCol<Vol>(multi),
          { k: "size", label: "Size", sort: (v) => parseBytes(v.config.size) ?? -1, cell: (v) => <span className="mono">{v.config.size || "–"}</span>, cls: "right hide-s" },
          { k: "used", label: "Used by", sort: (v) => v.used_by?.length || 0, cell: (v) => <UsedBy list={v.used_by} />, cls: "right" },
        ]}
      />
      <EditSheet<VolPut>
        open={create || !!edit}
        onClose={() => (setCreate(false), setEdit(null))}
        title={edit ? `Volume ${edit.name}` : "Create volume"}
        create={!edit}
        value={edit ? { description: edit.description, config: edit.config } : create ? { name: "", pool: "", content_type: "filesystem", description: "", config: { size: "10GiB" } } : null}
        onSave={save}
        onDelete={edit ? () => del(edit) : undefined}
        info={
          edit && (
            <>
              <dl className="kv tight">
                <dt>Pool</dt>
                <dd>{edit.pool}</dd>
                <dt>Content</dt>
                <dd>{edit.content_type}</dd>
                {state.data && (
                  <>
                    <dt>Space</dt>
                    <dd>
                      {bytes(state.data.used)}
                      {state.data.total ? ` of ${bytes(state.data.total)}` : ""} used
                    </dd>
                  </>
                )}
                <dt>Used by</dt>
                <dd>
                  <UsedList list={edit.used_by} server={edit.server} detach={(k, n, pr) => doDetach(edit, k, n, pr)} />
                </dd>
              </dl>
              <SheetSec title="Attach to an instance">
                <div className="two">
                  <Select
                    value={attach.inst}
                    onChange={(v) => setAttach({ ...attach, inst: v })}
                    options={[{ v: "", l: "Choose an instance" }, ...(insts.data || []).filter((i) => i.server === edit.server && (edit.content_type !== "block" || i.type === "virtual-machine")).map((i) => ({ v: i.name, l: i.name }))]}
                  />
                  {edit.content_type !== "block" && <Input mono value={attach.path} onChange={(v) => setAttach({ ...attach, path: v })} placeholder="/mnt/data" />}
                </div>
                <div>
                  <button className="btn btn-s btn-sm tt press" disabled={!attach.inst} onClick={() => doAttach(edit)}>
                    {ic.link}Attach
                  </button>
                </div>
                {edit.content_type === "block" && <span className="dim" style={{ fontSize: 12.5 }}>Block volumes attach to virtual machines only.</span>}
              </SheetSec>
              <VolSnapshots v={edit} project={project} path={volPath(edit)} />
            </>
          )
        }
        form={(d, set) => (
          <>
            {!edit && (
              <>
                <div className="two">
                  <Field label="Name">
                    <Input autoFocus mono value={d.name || ""} onChange={(v) => set((x) => void (x.name = v))} placeholder="data" />
                  </Field>
                  <Field label="Pool">
                    <Select value={d.pool || pools.data?.[0] || ""} onChange={(v) => set((x) => void (x.pool = v))} options={pools.data || []} />
                  </Field>
                </div>
                {servers.length > 1 && (
                  <Field label="Server">
                    <Select value={srv} onChange={setServer} options={servers.map((s) => s.name)} />
                  </Field>
                )}
                <Field label="Content">
                  <Seg
                    value={d.content_type || "filesystem"}
                    onChange={(v) => set((x) => void (x.content_type = v))}
                    options={[
                      { v: "filesystem", l: "Filesystem" },
                      { v: "block", l: "Block, for VMs" },
                    ]}
                  />
                </Field>
              </>
            )}
            <div className="two">
              <Field label="Size" hint="Like 10GiB. Empty means no quota where the driver allows it.">
                <Input mono value={d.config.size || ""} onChange={(v) => set((x) => (v ? (x.config.size = v) : delete x.config.size))} />
              </Field>
              <Field label="Description">
                <Input value={d.description} onChange={(v) => set((x) => void (x.description = v))} />
              </Field>
            </div>
            {edit && (
              <div className="two">
                <Field label="Snapshot schedule" hint="Like @daily or 0 3 * * *. Empty means none.">
                  <Input mono value={d.config["snapshots.schedule"] || ""} onChange={(v) => set((x) => (v ? (x.config["snapshots.schedule"] = v) : delete x.config["snapshots.schedule"]))} placeholder="@daily" />
                </Field>
                <Field label="Keep scheduled snapshots" hint="Like 7d or 4w. Empty keeps them.">
                  <Input mono value={d.config["snapshots.expiry"] || ""} onChange={(v) => set((x) => (v ? (x.config["snapshots.expiry"] = v) : delete x.config["snapshots.expiry"]))} placeholder="7d" />
                </Field>
              </div>
            )}
            <SheetSec title="All settings">
              <KVEditor value={d.config} onChange={(c) => set((x) => void (x.config = c))} keys={["size", "snapshots.schedule", "snapshots.expiry", "security.shifted", "security.unmapped", "block.filesystem", "block.mount_options"]} hide={(k) => k.startsWith("volatile.")} />
            </SheetSec>
          </>
        )}
      />
    </>
  );
}

type VolSnap = { name: string; created_at: string; expires_at: string | null };

// Snapshots of one custom volume. Incus lists them as "volume/snapshot".
function VolSnapshots({ v, project, path }: { v: Vol; project: string; path: string }) {
  const app = useApp();
  const q = useData<VolSnap[]>(`vol-snaps:${v.server}:${v.pool}:${v.name}:${project}`, async () => (await incus<VolSnap[]>(v.server, path + "/snapshots?recursion=1", { project })) || []);
  const [name, setName] = useState("");
  const [exp, setExp] = useState("");
  const snaps = (q.data || []).map((s) => ({ ...s, short: s.name.split("/").pop()! })).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const done = () => (invalidate("vol-snaps:"), invalidate("volumes:"));
  const create = async () => {
    const body: any = {};
    if (name.trim()) body.name = name.trim();
    if (exp) body.expires_at = new Date(exp).toISOString();
    const ok = await app.run(`Snapshot of ${v.name}`, () => incusOp(v.server, path + "/snapshots", { method: "POST", project, body }).then(() => true), "Snapshot created");
    if (ok) {
      setName("");
      setExp("");
      done();
    }
  };
  const restore = async (s: string) => {
    if (!(await confirmDialog({ title: `Restore ${s}?`, body: `${v.name} goes back to how it was at this snapshot. Changes since then are lost.`, confirm: "Restore", danger: true }))) return;
    const ok = await app.run(`Restoring ${s}`, () => incusOp(v.server, path, { method: "PUT", project, body: { restore: s } }).then(() => true), `${v.name} restored from ${s}`);
    if (ok) done();
  };
  const del = async (s: string) => {
    if (!(await confirmDialog({ title: `Delete snapshot ${s}?`, body: "This can't be undone.", confirm: "Delete", danger: true }))) return;
    const ok = await app.run(`Deleting ${s}`, () => incusOp(v.server, `${path}/snapshots/${encodeURIComponent(s)}`, { method: "DELETE", project }).then(() => true), `Snapshot ${s} deleted`);
    if (ok) done();
  };
  const expires = (s: VolSnap) => (s.expires_at && !s.expires_at.startsWith("0001") ? dateTime(s.expires_at) : "");
  return (
    <SheetSec title="Snapshots">
      <div className="two">
        <Field label="Name">
          <Input mono value={name} onChange={setName} placeholder="Optional" onKeyDown={(e) => e.key === "Enter" && create()} />
        </Field>
        <Field label="Expires">
          <div className="field">
            <input type="datetime-local" value={exp} onChange={(e) => setExp(e.target.value)} aria-label="Expires" />
          </div>
        </Field>
      </div>
      <div>
        <button className="btn btn-s btn-sm tt press" onClick={create}>
          {ic.snap}Take snapshot
        </button>
      </div>
      {q.data && !snaps.length && <span className="dim" style={{ fontSize: 12.5 }}>No snapshots yet.</span>}
      {!!snaps.length && (
        <div className="dl">
          {snaps.map((s) => (
            <div className="snr" key={s.name}>
              <span>
                <b className="mono">{s.short}</b>
                <small className="dim">
                  {dateTime(s.created_at)}
                  {expires(s) && ` · expires ${expires(s)}`}
                </small>
              </span>
              <button className="btn btn-q btn-sm press" onClick={() => restore(s.short)}>
                Restore
              </button>
              <button className="btn btn-q ib btn-sm" aria-label={"Delete " + s.short} onClick={() => del(s.short)}>
                {ic.trash}
              </button>
            </div>
          ))}
        </div>
      )}
    </SheetSec>
  );
}

// ---------- custom ISOs ----------

export function Isos() {
  useCrumbs([{ label: "Storage" }, { label: "Custom ISOs" }]);
  const app = useApp();
  const nav = useNavigate();
  const project = useCurrentProject();
  const servers = useScopedServers();
  const multi = app.servers.length > 1;
  const q = useVolumes((v) => v.content_type === "iso", "isos");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const del = async (v: Vol) => {
    if (!(await confirmDialog({ title: `Delete ${v.name}?`, body: v.used_by?.length ? "Detach it from its VMs first." : "The ISO is removed from the pool.", confirm: "Delete", danger: true }))) return;
    const ok = await app.run(`Deleting ${v.name}`, () => incusOp(v.server, `/1.0/storage-pools/${encodeURIComponent(v.pool)}/volumes/custom/${encodeURIComponent(v.name)}`, { method: "DELETE", project }).then(() => true), `${v.name} deleted`);
    if (ok) invalidate("volumes:");
  };
  return (
    <>
      <PageHead title="Custom ISOs">
        <button className="btn btn-p press" onClick={() => setOpen(true)}>
          {ic.up}Upload ISO
        </button>
      </PageHead>
      <div className="fbar">
        <Search value={search} onChange={setSearch} placeholder="Filter by name" />
        <span className="dim fnote">Installer images for VMs. Pick one under ISO when you create a VM.</span>
      </div>
      <Table<Vol>
        rows={q.data?.filter((v) => matches(search, v.name, v.pool))}
        loading={q.loading}
        rowKey={(v) => v.server + v.pool + v.name}
        empty={q.error || (search ? "No ISOs match." : "No ISOs yet.")}
        cols={[
          { k: "name", label: "Name", sort: (v) => v.name, cell: (v) => <NameCell name={v.name} sub={v.description} /> },
          { k: "pool", label: "Pool", sort: (v) => v.pool, cell: (v) => v.pool },
          serverCol<Vol>(multi),
          { k: "size", label: "Size", sort: (v) => parseBytes(v.config.size) ?? -1, cell: (v) => <span className="mono">{v.config.size ? bytes(parseBytes(v.config.size)) : "–"}</span>, cls: "right hide-s" },
          { k: "used", label: "Used by", sort: (v) => v.used_by?.length || 0, cell: (v) => <UsedBy list={v.used_by} />, cls: "right" },
          {
            k: "act",
            label: "",
            cell: (v) => (
              <div className="qa" style={{ opacity: 1 }}>
                <button className="btn btn-q btn-sm" onClick={() => nav("/instances?create=1&iso=" + encodeURIComponent(v.pool + "/" + v.name))}>
                  Create VM
                </button>
                <button className="btn btn-q ib btn-sm" aria-label={"Delete " + v.name} onClick={() => del(v)}>
                  {ic.trash}
                </button>
              </div>
            ),
          },
        ]}
      />
      <UploadIso open={open} onClose={() => setOpen(false)} servers={servers.map((s) => s.name)} project={project} />
    </>
  );
}

function UploadIso({ open, onClose, servers, project }: { open: boolean; onClose: () => void; servers: string[]; project: string }) {
  const app = useApp();
  const [server, setServer] = useState("");
  const srv = server || servers[0] || "";
  const pools = useNames(open ? srv : "", "storage-pools");
  const [pool, setPool] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [frac, setFrac] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const pick = (f: File | undefined) => {
    if (!f) return;
    setFile(f);
    setName(f.name.replace(/\.iso$/i, "").replace(/[^a-zA-Z0-9_.-]/g, "-"));
  };
  const go = async () => {
    if (!file || !name) return;
    const p = pool || pools.data?.[0] || "default";
    setFrac(0);
    const ok = await app.run(
      `Uploading ${file.name}`,
      async (progress) => {
        const d = await upload(incusURL(srv, `/1.0/storage-pools/${encodeURIComponent(p)}/volumes/custom`, project), file, { "X-Incus-name": name, "X-Incus-type": "iso", "Content-Type": "application/octet-stream" }, (f) => {
          setFrac(f);
          progress(`${Math.round(f * 100)}%`);
        });
        if (d?.type === "async") await waitOp(srv, d.metadata.id, project);
        return true;
      },
      `${name} uploaded`,
    );
    setFrac(null);
    if (ok) {
      invalidate("volumes:");
      setFile(null);
      onClose();
    }
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Upload ISO"
      footer={
        <>
          <button className="btn btn-s press" onClick={onClose}>
            {frac !== null ? "Hide" : "Cancel"}
          </button>
          <button className="btn btn-p press" disabled={!file || !name || frac !== null} onClick={go}>
            Upload
          </button>
        </>
      }
    >
      <div
        className="drop"
        onClick={() => input.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          pick(e.dataTransfer.files[0]);
        }}
      >
        {ic.up}
        <b>{file ? file.name : "Drop an ISO here or click to choose"}</b>
        <span className="dim">{file ? bytes(file.size) : "It goes into a storage pool on the server."}</span>
        <input ref={input} type="file" accept=".iso" hidden onChange={(e) => pick(e.target.files?.[0])} />
      </div>
      {frac !== null && (
        <div className="prog">
          <i style={{ transform: `scaleX(${frac})` }} />
        </div>
      )}
      <Field label="Name">
        <Input mono value={name} onChange={setName} />
      </Field>
      <div className="two">
        <Field label="Pool">
          <Select value={pool || pools.data?.[0] || ""} onChange={setPool} options={pools.data || []} />
        </Field>
        {servers.length > 1 && (
          <Field label="Server">
            <Select value={srv} onChange={setServer} options={servers} />
          </Field>
        )}
      </div>
    </Sheet>
  );
}

// ---------- buckets ----------

type Bucket = { name: string; description: string; config: Record<string, string>; s3_url: string; location: string; pool: string; server: string };

export function Buckets() {
  useCrumbs([{ label: "Storage" }, { label: "Buckets" }]);
  const app = useApp();
  const project = useCurrentProject();
  const servers = useScopedServers();
  const multi = app.servers.length > 1;
  const names = servers.map((s) => s.name).join(",");
  const q = useData<{ rows: Bucket[]; pools: { server: string; name: string }[] }>(names ? `buckets:${names}:${project}` : null, async () => {
    const rows: Bucket[] = [];
    const pools: { server: string; name: string }[] = [];
    await Promise.all(
      servers.map(async (s) => {
        const ps = (await incus<string[]>(s.name, "/1.0/storage-pools")) || [];
        await Promise.all(
          ps.map(async (u) => {
            const pool = decodeURIComponent(u.split("/").pop()!);
            const list = await incus<Bucket[]>(s.name, `/1.0/storage-pools/${encodeURIComponent(pool)}/buckets?recursion=1`, { project }).catch(() => null);
            if (list) {
              pools.push({ server: s.name, name: pool });
              rows.push(...list.map((b) => ({ ...b, pool, server: s.name })));
            }
          }),
        );
      }),
    );
    return { rows, pools };
  });
  const cfg = useData<any>(servers[0] ? `server-info:${servers[0].name}` : null, () => incus(servers[0].name, "/1.0"));
  const noAddr = cfg.data && !cfg.data.config?.["core.storage_buckets_address"];
  const [search, setSearch] = useState("");
  const [edit, setEdit] = useState<Bucket | null>(null);
  const [create, setCreate] = useState(false);
  const [target, setTarget] = useState("");
  const pools = q.data?.pools || [];
  const tp = pools.find((p) => p.server + "/" + p.name === target) || pools[0];
  const bpath = (b: Bucket) => `/1.0/storage-pools/${encodeURIComponent(b.pool)}/buckets/${encodeURIComponent(b.name)}`;

  type BPut = { name?: string; description: string; config: Record<string, string> };
  const save = async (d: BPut) => {
    if (!edit) {
      if (!tp) return void app.toast("No pool here supports buckets.");
      if (!/^[a-z0-9][a-z0-9.-]{2,62}$/.test(d.name || "")) return void app.toast("Bucket names use 3 to 63 lowercase letters, numbers, dots and dashes.");
      const ok = await app.run(`Creating bucket ${d.name}`, () => incusOp(tp.server, `/1.0/storage-pools/${encodeURIComponent(tp.name)}/buckets`, { method: "POST", project, body: d }).then(() => true), `Bucket ${d.name} created`);
      if (ok) invalidate("buckets:");
      return ok;
    }
    const ok = await app.run(`Saving ${edit.name}`, () => incusOp(edit.server, bpath(edit), { method: "PUT", project, body: { description: d.description, config: d.config } }).then(() => true), `Bucket ${edit.name} saved`);
    if (ok) invalidate("buckets:");
    return ok;
  };
  const del = async (b: Bucket) => {
    if (!(await confirmDialog({ title: `Delete bucket ${b.name}?`, body: "Everything in it is removed.", confirm: "Delete", danger: true, typeToConfirm: b.name }))) return;
    const ok = await app.run(`Deleting ${b.name}`, () => incusOp(b.server, bpath(b), { method: "DELETE", project }).then(() => true), `Bucket ${b.name} deleted`);
    if (ok) {
      setEdit(null);
      invalidate("buckets:");
    }
  };

  return (
    <>
      <PageHead title="Buckets">
        <button className="btn btn-p press" onClick={() => setCreate(true)} disabled={!pools.length}>
          {ic.plus}Create bucket
        </button>
      </PageHead>
      <div className="fbar">
        <Search value={search} onChange={setSearch} placeholder="Filter by name" />
        <span className="dim fnote">S3-compatible object storage.</span>
      </div>
      {noAddr && (
        <div className="panel notice">
          <span className="ni-ic">{ic.cloud}</span>
          <div>
            <b>Buckets on local pools need an address</b>
            <p>
              Set <span className="mono">core.storage_buckets_address</span> on the host, for example <span className="mono">:8555</span>, under Hosts, then Configuration. Ceph object pools work without it.
            </p>
          </div>
        </div>
      )}
      <Table<Bucket>
        rows={q.data?.rows.filter((b) => matches(search, b.name, b.description))}
        loading={q.loading}
        rowKey={(b) => b.server + b.pool + b.name}
        onRow={setEdit}
        empty={q.error || (pools.length ? "No buckets yet." : "No storage pool here supports buckets.")}
        cols={[
          { k: "name", label: "Name", sort: (b) => b.name, cell: (b) => <NameCell name={b.name} sub={b.description} /> },
          { k: "pool", label: "Pool", sort: (b) => b.pool, cell: (b) => b.pool },
          serverCol<Bucket>(multi),
          { k: "size", label: "Quota", sort: (b) => parseBytes(b.config.size) ?? -1, cell: (b) => <span className="mono">{b.config.size || "–"}</span>, cls: "right" },
          { k: "url", label: "S3 address", sort: (b) => b.s3_url, cell: (b) => <span className="mono dim">{b.s3_url || "–"}</span>, cls: "hide-m" },
        ]}
      />
      <EditSheet<BPut>
        open={create || !!edit}
        onClose={() => (setCreate(false), setEdit(null))}
        title={edit ? `Bucket ${edit.name}` : "Create bucket"}
        create={!edit}
        value={edit ? { description: edit.description, config: edit.config } : create ? { name: "", description: "", config: {} } : null}
        onSave={save}
        onDelete={edit ? () => del(edit) : undefined}
        info={edit && <BucketKeys b={edit} project={project} />}
        form={(d, set) => (
          <>
            {!edit && (
              <div className="two">
                <Field label="Name">
                  <Input autoFocus mono value={d.name || ""} onChange={(v) => set((x) => void (x.name = v))} placeholder="backups" />
                </Field>
                <Field label="Pool">
                  <Select value={tp ? tp.server + "/" + tp.name : ""} onChange={setTarget} options={pools.map((p) => ({ v: p.server + "/" + p.name, l: multi ? `${p.name} on ${p.server}` : p.name }))} />
                </Field>
              </div>
            )}
            <div className="two">
              <Field label="Quota" hint="Like 50GiB. Empty means no limit.">
                <Input mono value={d.config.size || ""} onChange={(v) => set((x) => (v ? (x.config.size = v) : delete x.config.size))} />
              </Field>
              <Field label="Description">
                <Input value={d.description} onChange={(v) => set((x) => void (x.description = v))} />
              </Field>
            </div>
          </>
        )}
      />
    </>
  );
}

function BucketKeys({ b, project }: { b: Bucket; project: string }) {
  const app = useApp();
  const base = `/1.0/storage-pools/${encodeURIComponent(b.pool)}/buckets/${encodeURIComponent(b.name)}/keys`;
  const keys = useData<any[]>(`bucket-keys:${b.server}:${b.pool}:${b.name}`, () => incus(b.server, base + "?recursion=1", { project }));
  const add = async (role: "admin" | "read-only") => {
    await app.run("Creating key", () => incus(b.server, base, { method: "POST", project, body: { name: `${role === "admin" ? "rw" : "ro"}-${Date.now().toString(36)}`, role } }), "Key created");
    keys.reload();
  };
  const del = async (k: any) => {
    await app.run("Deleting key", () => incus(b.server, `${base}/${encodeURIComponent(k.name)}`, { method: "DELETE", project }), "Key deleted");
    keys.reload();
  };
  return (
    <>
      <dl className="kv tight">
        <dt>S3 address</dt>
        <dd className="mono">
          {b.s3_url || "–"}
          {b.s3_url && <CopyBtn text={b.s3_url} />}
        </dd>
        <dt>Pool</dt>
        <dd>{b.pool}</dd>
      </dl>
      <SheetSec
        title="Access keys"
        action={
          <span style={{ display: "flex", gap: 4, marginLeft: "auto" }}>
            <button className="btn btn-s btn-sm press" onClick={() => add("read-only")}>
              Read-only key
            </button>
            <button className="btn btn-s btn-sm press" onClick={() => add("admin")}>
              {ic.plus}Key
            </button>
          </span>
        }
      >
        {(keys.data || []).length === 0 && <span className="dim" style={{ fontSize: 12.5 }}>No keys yet.</span>}
        <div className="dl">
          {(keys.data || []).map((k) => (
            <div className="drow" key={k.name} style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1.4fr) auto" }}>
              <span>
                <b style={{ fontWeight: 500 }}>{k.name}</b>
                <small className="dim" style={{ display: "block" }}>
                  {k.role}
                </small>
              </span>
              <span className="mono" style={{ fontSize: 12, overflowWrap: "anywhere" }}>
                {k["access-key"]}
                <CopyBtn text={k["access-key"]} />
                <br />
                <span className="dim">secret</span> <CopyBtn text={k["secret-key"]} />
              </span>
              <button className="btn btn-q ib btn-sm" aria-label="Delete key" onClick={() => del(k)}>
                {ic.trash}
              </button>
            </div>
          ))}
        </div>
      </SheetSec>
    </>
  );
}
