import { useState } from "react";
import { bytes, incus, incusOp } from "../api";
import { ic } from "../icons";
import { useCrumbs } from "../Shell";
import { invalidate, useApp, useData, useScopedServers } from "../state";
import { useCollection } from "../data";
import { confirmDialog, Field, Input, KVEditor, Select, SheetSec, Table, TglRow } from "../ui";
import { EditSheet, matches, PageHead, Search, UsedBy } from "./Resource";
import { UsedBySec, usedByBody, useOpenParam } from "./usedby";

type Project = { name: string; description: string; config: Record<string, string>; used_by: string[]; server: string };
type PrPut = { name?: string; description: string; config: Record<string, string>; copyDefault?: boolean };

const features: { k: string; l: string; note: string }[] = [
  { k: "features.images", l: "Own images", note: "Images pulled here stay in this project." },
  { k: "features.profiles", l: "Own profiles", note: "Profiles here are separate from other projects." },
  { k: "features.storage.volumes", l: "Own volumes", note: "Custom volumes stay in this project." },
  { k: "features.storage.buckets", l: "Own buckets", note: "Buckets stay in this project." },
  { k: "features.networks", l: "Own networks", note: "Networks made here only exist in this project." },
  { k: "features.networks.zones", l: "Own DNS zones", note: "Network zones stay in this project." },
];

const limitKeys = ["limits.instances", "limits.containers", "limits.virtual-machines", "limits.cpu", "limits.memory", "limits.disk", "limits.networks", "limits.processes", "restricted", "restricted.containers.nesting", "restricted.devices.disk", "restricted.devices.nic", "restricted.virtual-machines.lowlevel", "backups.compression_algorithm", "images.auto_update_interval"];

export function Projects() {
  useCrumbs([{ label: "Projects" }]);
  const app = useApp();
  const servers = useScopedServers();
  const multi = app.servers.length > 1;
  const q = useCollection<Project>("projects", "/1.0/projects?recursion=1");
  const [search, setSearch] = useState("");
  const [edit, setEdit] = useState<Project | null>(null);
  const [create, setCreate] = useState(false);
  const [server, setServer] = useState("");
  const srv = edit?.server || server || servers[0]?.name || "";
  useOpenParam(q.data, setEdit);

  const save = async (d: PrPut) => {
    if (!edit) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(d.name || "")) return void app.toast("Give the project a name: letters, numbers, dashes, dots.");
      const config = Object.fromEntries(Object.entries(d.config).filter(([k, v]) => k && v !== ""));
      const ok = await app.run(
        `Creating project ${d.name}`,
        async () => {
          await incusOp(srv, "/1.0/projects", { method: "POST", body: { name: d.name, description: d.description, config } });
          // A project with its own profiles starts with an empty default profile.
          // Copy the root disk and network card over so new instances just work.
          if (d.copyDefault && config["features.profiles"] === "true") {
            const def = await incus<any>(srv, "/1.0/profiles/default", { project: "default" });
            await incus(srv, "/1.0/profiles/default", { method: "PUT", project: d.name, body: { description: def.description, config: def.config, devices: def.devices } });
          }
          return true;
        },
        `Project ${d.name} created`,
      );
      if (ok) {
        invalidate("projects");
        app.reloadServers();
      }
      return ok;
    }
    const ok = await app.run(`Saving ${edit.name}`, () => incusOp(edit.server, `/1.0/projects/${encodeURIComponent(edit.name)}`, { method: "PUT", body: { description: d.description, config: d.config } }).then(() => true), `Project ${edit.name} saved`);
    if (ok) invalidate("projects");
    return ok;
  };
  const del = async (p: Project) => {
    const used = (p.used_by || []).filter((u) => !u.includes("/profiles/default"));
    if (!(await confirmDialog({ title: `Delete project ${p.name}?`, body: used.length ? usedByBody(`It still holds ${used.length} things. Incus refuses to delete it until it's empty.`, used, p.server) : "The project is empty.", confirm: "Delete", danger: true, typeToConfirm: p.name }))) return;
    const ok = await app.run(`Deleting ${p.name}`, () => incusOp(p.server, `/1.0/projects/${encodeURIComponent(p.name)}`, { method: "DELETE" }).then(() => true), `Project ${p.name} deleted`);
    if (ok) {
      if (app.project === p.name) app.setProject("default");
      setEdit(null);
      invalidate("projects");
    }
  };

  return (
    <>
      <PageHead title="Projects">
        <button className="btn btn-p press" onClick={() => setCreate(true)}>
          {ic.plus}Create project
        </button>
      </PageHead>
      <div className="fbar">
        <Search value={search} onChange={setSearch} placeholder="Filter by name" />
        <span className="dim fnote">Projects split instances and their resources into separate groups, each with its own limits.</span>
      </div>
      <Table<Project>
        rows={q.data?.filter((p) => matches(search, p.name, p.description))}
        loading={q.loading}
        rowKey={(p) => p.server + p.name}
        onRow={setEdit}
        empty={q.error || "No projects match."}
        cols={[
          {
            k: "name",
            label: "Name",
            sort: (p) => p.name,
            cell: (p) => (
              <span className="nm">
                <span className="nm2">
                  {p.name}
                  {app.project === p.name && <span className="tag" style={{ marginLeft: 8 }}>current</span>}
                </span>
                {p.description && <small className="dim">{p.description}</small>}
              </span>
            ),
          },
          { k: "server", label: "Server", sort: (p) => p.server, cell: (p) => p.server, hide: !multi, cls: "hide-m" },
          { k: "features", label: "Has its own", cell: (p) => <span className="dim">{features.filter((f) => p.config[f.k] === "true").map((f) => f.l.replace("Own ", "")).join(", ") || "nothing, shares default"}</span>, cls: "hide-s wrap-cell" },
          { k: "used", label: "Used by", sort: (p) => p.used_by?.length || 0, cell: (p) => <UsedBy list={p.used_by} />, cls: "right" },
          {
            k: "go",
            label: "",
            cell: (p) =>
              app.project !== p.name ? (
                <div className="qa">
                  <button
                    className="btn btn-q btn-sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      app.setProject(p.name);
                      app.toast(`Switched to project ${p.name}`);
                    }}
                  >
                    Switch to
                  </button>
                </div>
              ) : null,
          },
        ]}
      />
      <EditSheet<PrPut>
        open={create || !!edit}
        onClose={() => (setCreate(false), setEdit(null))}
        title={edit ? `Project ${edit.name}` : "Create project"}
        create={!edit}
        value={
          edit
            ? { description: edit.description, config: edit.config }
            : create
              ? { name: "", description: "", copyDefault: true, config: { "features.images": "true", "features.profiles": "true", "features.storage.volumes": "true", "features.storage.buckets": "true" } }
              : null
        }
        onSave={save}
        onDelete={edit && edit.name !== "default" ? () => del(edit) : undefined}
        info={
          edit && (
            <>
              <Usage server={edit.server} name={edit.name} />
              <UsedBySec list={edit.used_by} server={edit.server} title="Holds" />
            </>
          )
        }
        form={(d, set) => {
          const setCfg = (k: string, v: string) => set((x) => (v === "" ? delete x.config[k] : (x.config[k] = v)));
          return (
            <>
              {!edit && (
                <div className="two">
                  <Field label="Name">
                    <Input autoFocus mono value={d.name || ""} onChange={(v) => set((x) => void (x.name = v))} placeholder="staging" />
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
              <SheetSec title="Separate from other projects">
                <div className="tglgrid">
                  {features.map((f) => (
                    <TglRow key={f.k} title={f.l} note={f.note} on={d.config[f.k] === "true"} onChange={(o) => setCfg(f.k, edit ? String(o) : o ? "true" : "")} />
                  ))}
                </div>
                {!edit && d.config["features.profiles"] === "true" && (
                  <TglRow title="Copy the default profile" note="Gives the new project the same root disk and network card, so instances start right away." on={!!d.copyDefault} onChange={(o) => set((x) => void (x.copyDefault = o))} />
                )}
                {edit && <span className="dim" style={{ fontSize: 12.5 }}>Most of these can only change while the project is empty.</span>}
              </SheetSec>
              <SheetSec title="Limits">
                <div className="two">
                  <Field label="Instances" hint="Empty means no limit.">
                    <Input mono value={d.config["limits.instances"] || ""} onChange={(v) => setCfg("limits.instances", v.replace(/\D/g, ""))} />
                  </Field>
                  <Field label="CPU cores, all instances together">
                    <Input mono value={d.config["limits.cpu"] || ""} onChange={(v) => setCfg("limits.cpu", v.replace(/\D/g, ""))} />
                  </Field>
                  <Field label="Memory, all together" hint="Like 16GiB.">
                    <Input mono value={d.config["limits.memory"] || ""} onChange={(v) => setCfg("limits.memory", v)} />
                  </Field>
                  <Field label="Disk, all together" hint="Like 200GiB.">
                    <Input mono value={d.config["limits.disk"] || ""} onChange={(v) => setCfg("limits.disk", v)} />
                  </Field>
                </div>
                <span className="dim" style={{ fontSize: 12.5 }}>
                  With a CPU, memory or disk limit, every instance in the project needs its own limit for that too.
                </span>
              </SheetSec>
              <SheetSec title="All settings">
                <KVEditor value={d.config} onChange={(c) => set((x) => void (x.config = c))} keys={[...features.map((f) => f.k), ...limitKeys]} />
              </SheetSec>
            </>
          );
        }}
      />
    </>
  );
}

// Usage against the project's limits.
function Usage({ server, name }: { server: string; name: string }) {
  const q = useData<any>(`project-state:${server}:${name}`, () => incus(server, `/1.0/projects/${encodeURIComponent(name)}/state`));
  const r = q.data?.resources;
  if (!r) return null;
  const rows: [string, string, boolean][] = [
    ["instances", "Instances", false],
    ["containers", "Containers", false],
    ["virtual-machines", "VMs", false],
    ["cpu", "CPU cores", false],
    ["memory", "Memory", true],
    ["disk", "Disk", true],
    ["processes", "Processes", false],
    ["networks", "Networks", false],
  ];
  return (
    <SheetSec title="Usage">
      <div className="usage panel" style={{ boxShadow: "inset 0 0 0 1px var(--line)" }}>
        {rows
          .filter(([k]) => r[k])
          .map(([k, l, isBytes]) => {
            const u = r[k].Usage ?? r[k].usage ?? 0;
            const lim = r[k].Limit ?? r[k].limit ?? -1;
            const f = (n: number) => (isBytes ? bytes(n) : String(n));
            return (
              <div key={k}>
                <label>{l}</label>
                <div className="v">
                  {f(u)} <span className="dim">{lim >= 0 ? `of ${f(lim)}` : "no limit"}</span>
                </div>
                {lim > 0 && (
                  <div className="bar">
                    <i style={{ transform: `scaleX(${Math.min(1, u / lim)})` }} className={u / lim > 0.9 ? "hot" : ""} />
                  </div>
                )}
              </div>
            );
          })}
      </div>
    </SheetSec>
  );
}
