import { useState } from "react";
import { incus, incusOp } from "../api";
import { ic } from "../icons";
import { useCrumbs } from "../Shell";
import { invalidate, useApp, useData, useScopedServers } from "../state";
import { useCollection, useCurrentProject, useManagedNetworks, useNames } from "../data";
import { confirmDialog, Field, Input, KVEditor, Select, SheetSec, Table, TglRow } from "../ui";
import { EditSheet, matches, PageHead, Search, UsedBy } from "./Resource";
import { NameCell } from "./Networks";
import { UsedBySec, usedByBody, useOpenParam } from "./usedby";
import { instanceKeys } from "./CreateInstance";

type Dev = Record<string, string>;
type Profile = { name: string; description: string; config: Record<string, string>; devices: Record<string, Dev>; used_by: string[]; server: string };
type PPut = { name?: string; description: string; config: Record<string, string>; devices: Record<string, Dev> };

export function Profiles() {
  useCrumbs([{ label: "Profiles" }]);
  const app = useApp();
  const project = useCurrentProject();
  const servers = useScopedServers();
  const multi = app.servers.length > 1;
  const q = useCollection<Profile>("profiles", "/1.0/profiles?recursion=1");
  const [search, setSearch] = useState("");
  const [edit, setEdit] = useState<Profile | null>(null);
  const [create, setCreate] = useState<PPut | null>(null);
  const [server, setServer] = useState("");
  const srv = edit?.server || server || servers[0]?.name || "";
  const pools = useNames(create || edit ? srv : "", "storage-pools", project);
  const nets = useManagedNetworks(create || edit ? srv : "", project);
  useOpenParam(q.data, setEdit);
  // A project without its own profiles shows the ones from project default.
  const proj = useData<{ config: Record<string, string> }>(`project-cfg:${srv}:${project}`, () => incus(srv, `/1.0/projects/${encodeURIComponent(project)}`));
  const shared = project !== "default" && !!proj.data && proj.data.config?.["features.profiles"] !== "true";

  const save = async (d: PPut) => {
    if (!edit) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(d.name || "")) return void app.toast("Give the profile a name.");
      const ok = await app.run(`Creating profile ${d.name}`, () => incusOp(srv, "/1.0/profiles", { method: "POST", project, body: d }).then(() => true), `Profile ${d.name} created`);
      if (ok) invalidate("profiles:");
      return ok;
    }
    const ok = await app.run(`Saving profile ${edit.name}`, () => incusOp(edit.server, `/1.0/profiles/${encodeURIComponent(edit.name)}`, { method: "PUT", project, body: { description: d.description, config: d.config, devices: d.devices } }).then(() => true), `Profile ${edit.name} saved`);
    if (ok) invalidate("profiles:");
    return ok;
  };
  const del = async (p: Profile) => {
    if (!(await confirmDialog({ title: `Delete profile ${p.name}?`, body: usedByBody(shared ? "Instances in several projects may use it. Incus refuses to delete it until they don't." : "These use it; Incus refuses to delete it until they don't.", p.used_by, p.server), confirm: "Delete", danger: true }))) return;
    const ok = await app.run(`Deleting ${p.name}`, () => incusOp(p.server, `/1.0/profiles/${encodeURIComponent(p.name)}`, { method: "DELETE", project }).then(() => true), `Profile ${p.name} deleted`);
    if (ok) {
      setEdit(null);
      invalidate("profiles:");
    }
  };

  return (
    <>
      <PageHead title="Profiles">
        <button className="btn btn-p press" onClick={() => setCreate({ name: "", description: "", config: {}, devices: {} })}>
          {ic.plus}
          {shared ? "Create profile in default" : "Create profile"}
        </button>
      </PageHead>
      <div className="fbar">
        <Search value={search} onChange={setSearch} placeholder="Filter by name" />
        <span className="dim fnote">Settings and devices that instances share. Changes apply to every instance that uses the profile.</span>
      </div>
      {shared && (
        <div className="notice sm" style={{ marginBottom: 12 }}>
          Project {project} has no profiles of its own, so these are the profiles from project default. Changing them changes them for every project that shares them.
        </div>
      )}
      <Table<Profile>
        rows={q.data?.filter((p) => matches(search, p.name, p.description))}
        loading={q.loading}
        rowKey={(p) => p.server + p.name}
        onRow={setEdit}
        empty={q.error || "No profiles match."}
        cols={[
          { k: "name", label: "Name", sort: (p) => p.name, cell: (p) => <NameCell name={p.name} sub={p.description} /> },
          { k: "server", label: "Server", sort: (p) => p.server, cell: (p) => p.server, hide: !multi, cls: "hide-m" },
          { k: "limits", label: "Limits", cell: (p) => <span className="dim">{[p.config["limits.cpu"] && `${p.config["limits.cpu"]} CPU`, p.config["limits.memory"]].filter(Boolean).join(" · ") || "–"}</span>, cls: "hide-s" },
          { k: "devices", label: "Devices", cell: (p) => <span className="keys">{Object.keys(p.devices || {}).map((d) => <code key={d}>{d}</code>)}</span>, cls: "hide-s" },
          { k: "used", label: "Used by", sort: (p) => p.used_by?.length || 0, cell: (p) => <UsedBy list={p.used_by} />, cls: "right" },
        ]}
      />
      <EditSheet<PPut>
        open={!!create || !!edit}
        onClose={() => (setCreate(null), setEdit(null))}
        title={edit ? `Profile ${edit.name}` : shared ? "Create profile in default" : "Create profile"}
        create={!edit}
        value={edit ? { description: edit.description, config: edit.config, devices: edit.devices } : create}
        onSave={save}
        onDelete={edit && edit.name !== "default" ? () => del(edit) : undefined}
        info={
          <>
            {!edit && shared && <div className="notice sm">Project {project} shares profiles with default, so this profile is created in project default and shows up in every project that shares them. To keep profiles separate, turn on "Own profiles" for the project.</div>}
            {edit && <UsedBySec list={edit.used_by} server={edit.server} />}
          </>
        }
        form={(d, set) => (
          <>
            {!edit && (
              <div className="two">
                <Field label="Name">
                  <Input autoFocus mono value={d.name || ""} onChange={(v) => set((x) => void (x.name = v))} placeholder="small" />
                </Field>
                {servers.length > 1 ? (
                  <Field label="Server">
                    <Select value={srv} onChange={setServer} options={servers.map((s) => s.name)} />
                  </Field>
                ) : (
                  <span />
                )}
              </div>
            )}
            <Field label="Description">
              <Input value={d.description} onChange={(v) => set((x) => void (x.description = v))} />
            </Field>
            <ProfileForm d={d} set={set} pools={pools.data || []} nets={(nets.data || []).map((n) => n.name)} />
          </>
        )}
      />
    </>
  );
}

function ProfileForm({ d, set, pools, nets }: { d: PPut; set: (fn: (x: PPut) => void) => void; pools: string[]; nets: string[] }) {
  const setCfg = (k: string, v: string) => set((x) => (v === "" ? delete x.config[k] : (x.config[k] = v)));
  const nics = Object.entries(d.devices).filter(([, v]) => v.type === "nic");
  const disks = Object.entries(d.devices).filter(([n, v]) => v.type === "disk" && n !== "root");
  const others = Object.entries(d.devices).filter(([n, v]) => v.type !== "nic" && v.type !== "disk" && n);
  const root = d.devices.root;
  const free = (base: string) => {
    let i = base === "eth" ? 0 : 1;
    while (d.devices[base + i]) i++;
    return base + i;
  };
  return (
    <>
      <SheetSec title="Compute">
        <div className="two">
          <Field label="CPU cores" hint="Empty means all.">
            <Input mono value={d.config["limits.cpu"] || ""} onChange={(v) => setCfg("limits.cpu", v.replace(/[^\d,-]/g, ""))} />
          </Field>
          <Field label="Memory" hint="Like 2GiB. Empty means no limit.">
            <Input mono value={d.config["limits.memory"] || ""} onChange={(v) => setCfg("limits.memory", v)} />
          </Field>
        </div>
      </SheetSec>
      <SheetSec
        title="Root disk"
        action={
          root ? (
            <button className="btn btn-q btn-sm" onClick={() => set((x) => void delete x.devices.root)}>
              Remove
            </button>
          ) : (
            <button className="btn btn-s btn-sm press" onClick={() => set((x) => void (x.devices.root = { type: "disk", path: "/", pool: pools[0] || "default" }))}>
              {ic.plus}Add root disk
            </button>
          )
        }
      >
        {root ? (
          <div className="two">
            <Select value={root.pool || ""} onChange={(v) => set((x) => void (x.devices.root.pool = v))} options={pools} />
            <Input mono value={root.size || ""} onChange={(v) => set((x) => (v ? (x.devices.root.size = v) : delete x.devices.root.size))} placeholder="Size, like 20GiB" />
          </div>
        ) : (
          <span className="dim" style={{ fontSize: 12.5 }}>
            No root disk here. Instances need one from some profile.
          </span>
        )}
      </SheetSec>
      <SheetSec
        title="Network cards"
        action={
          <button className="btn btn-s btn-sm press" onClick={() => set((x) => void (x.devices[free("eth")] = { type: "nic", network: nets[0] || "incusbr0", name: free("eth") }))}>
            {ic.plus}Add
          </button>
        }
      >
        {nics.map(([n, v]) => (
          <div className="kvr" key={n}>
            <Input mono value={n} onChange={() => {}} readOnly />
            {v.network !== undefined ? (
              <Select value={v.network} onChange={(nw) => set((x) => void (x.devices[n].network = nw))} options={nets.includes(v.network) ? nets : [v.network, ...nets]} />
            ) : (
              <Input mono value={`${v.nictype || ""} ${v.parent || ""}`.trim()} onChange={() => {}} readOnly />
            )}
            <button className="btn btn-q ib btn-sm" aria-label={"Remove " + n} onClick={() => set((x) => void delete x.devices[n])}>
              {ic.x}
            </button>
          </div>
        ))}
      </SheetSec>
      <SheetSec
        title="Extra disks"
        action={
          <button className="btn btn-s btn-sm press" onClick={() => set((x) => void (x.devices[free("disk")] = { type: "disk", source: "", path: "" }))}>
            {ic.plus}Add
          </button>
        }
      >
        {disks.map(([n, v]) => (
          <div className="kvr" key={n} style={{ gridTemplateColumns: "90px minmax(0,1fr) minmax(0,1fr) auto" }}>
            <Input mono value={n} onChange={() => {}} readOnly />
            <Input mono value={v.source || ""} onChange={(s) => set((x) => void (x.devices[n].source = s))} placeholder="/srv/data or volume" />
            <Input mono value={v.path || ""} onChange={(s) => set((x) => void (x.devices[n].path = s))} placeholder="/mnt/data" />
            <button className="btn btn-q ib btn-sm" aria-label={"Remove " + n} onClick={() => set((x) => void delete x.devices[n])}>
              {ic.x}
            </button>
          </div>
        ))}
        {others.length > 0 && (
          <span className="dim" style={{ fontSize: 12.5 }}>
            Also has {others.map(([n, v]) => `${n} (${v.type})`).join(", ")}. Edit those in YAML.
          </span>
        )}
      </SheetSec>
      <SheetSec title="Options">
        <TglRow title="Start with the server" on={d.config["boot.autostart"] === "true"} onChange={(o) => setCfg("boot.autostart", o ? "true" : "")} />
        <TglRow title="Nesting" note="Containers can run Docker or Incus." on={d.config["security.nesting"] === "true"} onChange={(o) => setCfg("security.nesting", o ? "true" : "")} />
      </SheetSec>
      <SheetSec title="All settings">
        <KVEditor value={d.config} onChange={(c) => set((x) => void (x.config = c))} keys={["limits.cpu", "limits.memory", "boot.autostart", "security.nesting", "cloud-init.user-data", "cloud-init.network-config", ...instanceKeys]} />
      </SheetSec>
    </>
  );
}
