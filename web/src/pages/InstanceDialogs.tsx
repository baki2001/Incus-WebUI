import { useEffect, useState } from "react";
import { friendlyError, imageLabel, incus, incusOp, ui, type Instance } from "../api";
import { nameOf, setState, useNames } from "../data";
import { invalidate, useApp, useData } from "../state";
import { Dialog, Field, Input, Seg, Select } from "../ui";
import type { ImageSource } from "./CreateInstance";
import { ociRegistries, useImageServers } from "./ImagePicker";

type Inst = Instance & { server: string };

// ---------- stop confirmation with a "Force stop" option ----------

type StopAsk = { names: string[]; allFrozen: boolean };
let openStop: (a: StopAsk) => Promise<{ force: boolean } | null> = async () => null;

export function askStop(rows: { name: string; status: string }[]) {
  return openStop({ names: rows.map((r) => r.name), allFrozen: rows.every((r) => r.status === "Frozen") });
}

export function StopHost() {
  const [st, setSt] = useState<{ a: StopAsk; res: (v: { force: boolean } | null) => void } | null>(null);
  const [open, setOpen] = useState(false);
  const [force, setForce] = useState(false);
  openStop = (a) =>
    new Promise((res) => {
      setForce(false);
      setSt({ a, res });
      setOpen(true);
    });
  const close = (v: { force: boolean } | null) => {
    st?.res(v);
    setOpen(false);
  };
  const a = st?.a;
  const one = a && a.names.length === 1;
  return (
    <Dialog open={open} onClose={() => close(null)} size="sm">
      {a && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            close({ force: force || a.allFrozen });
          }}
        >
          <div className="dlg-b">
            <h2>{one ? `Stop ${a.names[0]}?` : `Stop ${a.names.length} instances?`}</h2>
            <p>{a.allFrozen ? "Paused instances can only be force stopped. Unsaved data is lost." : "Each instance gets up to 30 seconds to shut down cleanly."}</p>
            {!a.allFrozen && (
              <label className="check-row">
                <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
                <span>
                  Force stop
                  <small>Cuts the power right away. Unsaved data is lost.</small>
                </span>
              </label>
            )}
          </div>
          <div className="dlg-f">
            <button type="button" className="btn btn-s press" onClick={() => close(null)}>
              Cancel
            </button>
            <button type="submit" className={"btn press " + (force || a.allFrozen ? "btn-d" : "btn-p")} autoFocus>
              {force || a.allFrozen ? "Force stop" : "Stop"}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

// ---------- small form shell ----------

export function DlgForm({ title, intro, confirm, disabled, danger, onClose, onSubmit, children }: { title: string; intro?: string; confirm: string; disabled?: boolean; danger?: boolean; onClose: () => void; onSubmit: () => void; children: React.ReactNode }) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!disabled) onSubmit();
      }}
    >
      <div className="dlg-b">
        <h2>{title}</h2>
        {intro && <p>{intro}</p>}
        <div className="dlg-fields">{children}</div>
      </div>
      <div className="dlg-f">
        <button type="button" className="btn btn-s press" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className={"btn press " + (danger ? "btn-d" : "btn-p")} disabled={disabled}>
          {confirm}
        </button>
      </div>
    </form>
  );
}


const NAME_RE = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
export function nameProblem(n: string, taken: string[] = []) {
  if (!n) return "";
  if (!NAME_RE.test(n)) return "Use letters, numbers and dashes. Start and end with a letter or number.";
  if (taken.includes(n)) return `The name "${n}" is already used.`;
  return "";
}

// Turns the usual Incus errors into something to act on.
export function readable(e: unknown) {
  const m = e instanceof Error ? e.message : String(e);
  if (/already exists/i.test(m)) return "That name is already used. Pick another one.";
  if (/must be stopped|is running|not stopped/i.test(m)) return "Stop the instance first, then try again.";
  return friendlyError(e);
}

const rootPool = (i: Inst) => i.expanded_devices?.root?.pool || "";

// A running VM with migration.stateful set can move without stopping.
export const canLive = (i: Inst) => i.type === "virtual-machine" && i.expanded_config?.["migration.stateful"] === "true";

export function useClusterMembers(server: string, on: boolean) {
  return useData<string[]>(on && server ? `cluster-members:${server}` : null, async () => ((await incus<string[]>(server, "/1.0/cluster/members")) || []).map(nameOf));
}

// Where a copy or move can go: this server (and a cluster member on it), or
// another connected server the user may manage.
function useWhere(inst: Inst) {
  const app = useApp();
  const [server, setServer] = useState(inst.server);
  const [member, setMember] = useState("");
  const here = app.servers.find((s) => s.name === inst.server);
  const others = app.servers.filter((s) => s.name !== inst.server && s.online && s.trusted && app.can(s.name, "*", "manager"));
  const members = useClusterMembers(inst.server, !!here?.clustered && server === inst.server);
  const memberOpts = (members.data || []).filter((m) => m !== inst.location);
  const away = server !== inst.server;
  return { server, setServer: (v: string) => (setServer(v), setMember("")), member, setMember, others, memberOpts, away };
}

function WhereFields({ inst, w }: { inst: Inst; w: ReturnType<typeof useWhere> }) {
  return (
    <>
      {w.others.length > 0 && (
        <Field label="Server" hint={w.away ? `${w.server} pulls the instance straight from ${inst.server}, so it has to reach ${inst.server}'s API address.` : undefined}>
          <Select value={w.server} onChange={w.setServer} options={[{ v: inst.server, l: `${inst.server} (this server)` }, ...w.others.map((s) => ({ v: s.name, l: s.name }))]} />
        </Field>
      )}
      {!w.away && w.memberOpts.length > 0 && (
        <Field label="Cluster member">
          <Select value={w.member} onChange={w.setMember} options={[{ v: "", l: inst.location ? `Where it is now (${inst.location})` : "Where it is now" }, ...w.memberOpts.map((m) => ({ v: m, l: m }))]} />
        </Field>
      )}
    </>
  );
}

// Pools on the target server, with the original's pool first when it has one.
function useTargetPool(inst: Inst, server: string, project: string) {
  const pools = useNames(server, "storage-pools", project).data || [];
  const [pool, setPool] = useState(rootPool(inst));
  useEffect(() => {
    if (pools.length && !pools.includes(pool)) setPool(pools.includes(rootPool(inst)) ? rootPool(inst) : pools[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pools.join(","), server]);
  return { pools, pool, setPool };
}

// transfer starts a copy or move to another server as a background task.
async function transfer(app: ReturnType<typeof useApp>, inst: Inst, body: { target_server: string; target_project: string; target_name: string; pool: string; move: boolean; snapshots: boolean }) {
  try {
    await ui("/transfer", { method: "POST", body: { server: inst.server, project: inst.project, name: inst.name, ...body } });
    invalidate("ui-jobs");
    app.toast(`${body.move ? "Moving" : "Copying"} ${inst.name} to ${body.target_server}. Follow it under Tasks.`);
  } catch (e) {
    app.fail(e, `Couldn't start the ${body.move ? "move" : "copy"}.`);
  }
}
const done = () => {
  invalidate("instances:");
  invalidate("instance:");
};

// ---------- rename ----------

export function RenameDialog({ inst, open, onClose, onDone }: { inst: Inst; open: boolean; onClose: () => void; onDone: (name: string) => void }) {
  const app = useApp();
  const [name, setName] = useState(inst.name);
  const bad = nameProblem(name);
  return (
    <Dialog open={open} onClose={onClose} size="sm">
      <DlgForm
        title="Rename instance"
        intro="The instance has to be stopped. Its data stays as it is."
        confirm="Rename"
        disabled={!name || name === inst.name || !!bad}
        onClose={onClose}
        onSubmit={() => {
          onClose();
          app
            .run(
              `Renaming ${inst.name}`,
              async () => {
                try {
                  await incusOp(inst.server, `/1.0/instances/${encodeURIComponent(inst.name)}`, { method: "POST", project: inst.project, body: { name } });
                } catch (e) {
                  throw new Error(readable(e));
                }
                done();
                return true;
              },
              `Renamed to ${name}`,
            )
            .then((ok) => ok && onDone(name));
        }}
      >
        <Field label="New name" hint={bad} bad>
          <div className="field">
            <input autoFocus value={name} onChange={(e) => setName(e.target.value.trim())} />
          </div>
        </Field>
      </DlgForm>
    </Dialog>
  );
}

// ---------- copy ----------

export function CopyDialog({ inst, open, onClose, onDone }: { inst: Inst; open: boolean; onClose: () => void; onDone: (name: string, project: string) => void }) {
  const app = useApp();
  const w = useWhere(inst);
  const projects = useNames(w.server, "projects").data || [inst.project];
  const [name, setName] = useState(`${inst.name}-copy`);
  const [project, setProject] = useState(inst.project);
  const tp = useTargetPool(inst, w.server, project);
  const [snaps, setSnaps] = useState(false);
  const taken = useNames(w.server, "instances" as any, project).data || [];
  const bad = nameProblem(name, taken);
  const nSnaps = inst.snapshots?.length || 0;
  const vmRunning = inst.type === "virtual-machine" && inst.status !== "Stopped" && !canLive(inst);
  return (
    <Dialog open={open} onClose={onClose} size="sm">
      <DlgForm
        title="Copy instance"
        intro={vmRunning && w.away ? "Stop the VM first to copy it to another server." : "Makes a new instance from the current disk. A running instance is copied without its memory."}
        confirm="Copy"
        disabled={!name || !!bad || (vmRunning && w.away)}
        onClose={onClose}
        onSubmit={() => {
          onClose();
          if (w.away) {
            transfer(app, inst, { target_server: w.server, target_project: project, target_name: name, pool: tp.pool, move: false, snapshots: snaps });
            return;
          }
          const body: any = { name, profiles: inst.profiles, source: { type: "copy", source: inst.name, project: inst.project, live: false, instance_only: !snaps } };
          if (tp.pool && tp.pool !== rootPool(inst)) body.devices = { root: { ...(inst.expanded_devices?.root || { type: "disk", path: "/" }), pool: tp.pool } };
          const path = w.member ? `/1.0/instances?target=${encodeURIComponent(w.member)}` : "/1.0/instances";
          app
            .run(
              `Copying ${inst.name}`,
              async (progress) => {
                try {
                  await incusOp(inst.server, path, { method: "POST", project, body }, progress);
                } catch (e) {
                  throw new Error(readable(e));
                }
                done();
                return true;
              },
              `Copied to ${name}`,
            )
            .then((ok) => ok && onDone(name, project));
        }}
      >
        <Field label="New name" hint={bad} bad>
          <div className="field">
            <input autoFocus value={name} onChange={(e) => setName(e.target.value.trim())} />
          </div>
        </Field>
        <WhereFields inst={inst} w={w} />
        <Field label="Project">
          <Select value={project} onChange={setProject} options={projects.includes(project) ? projects : [project, ...projects]} />
        </Field>
        <Field label="Storage pool">
          <Select value={tp.pool} onChange={tp.setPool} options={(tp.pools.length ? tp.pools : [tp.pool]).map((p) => ({ v: p, l: !w.away && p === rootPool(inst) ? `${p} (same as the original)` : p }))} />
        </Field>
        {nSnaps > 0 && (
          <label className="check-row">
            <input type="checkbox" checked={snaps} onChange={(e) => setSnaps(e.target.checked)} />
            <span>
              Copy its {nSnaps} snapshot{nSnaps === 1 ? "" : "s"} too
            </span>
          </label>
        )}
      </DlgForm>
    </Dialog>
  );
}

// ---------- move ----------

export function MoveDialog({ inst, open, onClose, onDone }: { inst: Inst; open: boolean; onClose: () => void; onDone: (project: string, server: string) => void }) {
  const app = useApp();
  const w = useWhere(inst);
  const projects = useNames(w.server, "projects").data || [inst.project];
  const [project, setProject] = useState(inst.project);
  const tp = useTargetPool(inst, w.server, project);
  const running = inst.status !== "Stopped";
  const live = running && canLive(inst);
  const sameSpot = !w.away && !w.member && project === inst.project && tp.pool === rootPool(inst);
  const taken = useNames(w.server, "instances" as any, project).data || [];
  const clash = (w.away || project !== inst.project) && taken.includes(inst.name);
  // A running VM only changes where it runs; project and pool need it stopped.
  const locked = running && !w.away;
  const blocked = running && !live;
  return (
    <Dialog open={open} onClose={onClose} size="sm">
      <DlgForm
        title="Move instance"
        intro={
          blocked
            ? "Stop the instance first. Only VMs with migration.stateful set move while they run."
            : live
              ? `${inst.name} keeps running while it moves. Its name and data stay the same.`
              : w.away
                ? `Copies ${inst.name} to ${w.server} and deletes it here once the copy is there.`
                : "The instance has to be stopped. It keeps its name and data."
        }
        confirm="Move"
        disabled={blocked || sameSpot || clash || (locked && (project !== inst.project || tp.pool !== rootPool(inst)))}
        onClose={onClose}
        onSubmit={() => {
          onClose();
          if (w.away) {
            transfer(app, inst, { target_server: w.server, target_project: project, target_name: inst.name, pool: tp.pool, move: true, snapshots: true });
            return;
          }
          const body: any = { name: inst.name, migration: true };
          if (live) body.live = true;
          if (project !== inst.project) body.project = project;
          if (tp.pool !== rootPool(inst)) body.pool = tp.pool;
          const path = `/1.0/instances/${encodeURIComponent(inst.name)}` + (w.member ? `?target=${encodeURIComponent(w.member)}` : "");
          app
            .run(
              `Moving ${inst.name}`,
              async (progress) => {
                try {
                  await incusOp(inst.server, path, { method: "POST", project: inst.project, body }, progress);
                } catch (e) {
                  throw new Error(readable(e));
                }
                done();
                return true;
              },
              w.member ? `${inst.name} moved to ${w.member}` : `${inst.name} moved`,
            )
            .then((ok) => ok && onDone(project, inst.server));
        }}
      >
        <WhereFields inst={inst} w={w} />
        <Field label="Project" hint={clash ? `${w.away ? w.server + ", project " : ""}${project} already has an instance named ${inst.name}.` : locked ? "Stop the instance to change its project or pool." : undefined} bad={clash}>
          <Select value={project} onChange={setProject} options={projects.includes(project) ? projects : [project, ...projects]} disabled={locked} />
        </Field>
        <Field label="Storage pool">
          <Select value={tp.pool} onChange={tp.setPool} options={tp.pools.length ? tp.pools : [tp.pool]} disabled={locked} />
        </Field>
      </DlgForm>
    </Dialog>
  );
}

// ---------- rebuild ----------

// savedSource reads where the instance's image came from, or guesses it from
// the image keys Incus copied onto the instance.
function savedSource(inst: Inst, firstServer: string): { src: ImageSource | null; guessed: boolean } {
  try {
    const v = JSON.parse(inst.config?.["user.incus-webui.source"] || "");
    if (v?.alias && v?.protocol) return { src: v, guessed: false };
  } catch {
    /* none saved */
  }
  if (inst.config?.["volatile.container.oci"] === "true") return { src: null, guessed: true };
  const label = imageLabel(inst);
  if (inst.config?.["image.os"] && firstServer) return { src: { protocol: "simplestreams", server: firstServer, alias: label }, guessed: true };
  return { src: null, guessed: true };
}

function describeSource(s: ImageSource) {
  if (s.protocol === "oci") return `${s.alias} from ${ociRegistries.find((r) => r.url === s.server)?.name || s.server}`;
  if (s.protocol === "local") return `${s.alias}, on this server`;
  return `${s.alias} from ${s.server.replace(/^https?:\/\//, "")}`;
}

export function RebuildDialog({ inst, open, onClose }: { inst: Inst; open: boolean; onClose: () => void }) {
  const app = useApp();
  const imgServers = useImageServers().data || [];
  const known = savedSource(inst, imgServers[0]?.url || "");
  const same = known.src && !known.guessed ? known.src : null;
  const [mode, setMode] = useState<"same" | "other">(same ? "same" : "other");
  const [kind, setKind] = useState<ImageSource["protocol"]>(known.src?.protocol || (inst.config?.["volatile.container.oci"] === "true" ? "oci" : "simplestreams"));
  const [server, setServer] = useState(known.src?.protocol !== "local" ? known.src?.server || "" : "");
  const [alias, setAlias] = useState(known.src?.alias || "");
  const [delSnaps, setDelSnaps] = useState(false);
  const local = useData<any[]>(open && kind === "local" ? `images:${inst.server}:${inst.project}` : null, () => incus(inst.server, "/1.0/images?recursion=1", { project: inst.project }));
  const localOpts = (local.data || []).filter((i) => i.type === inst.type).flatMap((i) => (i.aliases?.length ? i.aliases.map((a: any) => ({ v: a.name, l: `${a.name}${i.properties?.description ? ` (${i.properties.description})` : ""}` })) : [{ v: i.fingerprint, l: `${i.properties?.description || i.fingerprint.slice(0, 12)}` }]));
  const srvOpts = kind === "oci" ? ociRegistries.map((r) => ({ v: r.url, l: r.name })) : imgServers.map((s) => ({ v: s.url, l: s.name }));
  const curServer = server && srvOpts.some((o) => o.v === server) ? server : srvOpts[0]?.v || server;
  const pick: ImageSource | null = mode === "same" ? same : alias.trim() ? { protocol: kind, server: kind === "local" ? "" : curServer, alias: alias.trim() } : null;
  const nSnaps = inst.snapshots?.length || 0;
  const running = inst.status !== "Stopped";
  const ok = !!pick && (nSnaps === 0 || delSnaps);
  // Start from what is known each time the dialog opens; the image servers may load after the page.
  useEffect(() => {
    if (!open) return;
    setMode(same ? "same" : "other");
    setKind(known.src?.protocol || (inst.config?.["volatile.container.oci"] === "true" ? "oci" : "simplestreams"));
    setServer(known.src?.protocol !== "local" ? known.src?.server || "" : "");
    setAlias(known.src?.alias || "");
    setDelSnaps(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, !!known.src]);
  const changeKind = (k: ImageSource["protocol"]) => {
    setKind(k);
    setServer("");
    setAlias(k === known.src?.protocol ? known.src.alias : "");
  };
  return (
    <Dialog open={open} onClose={onClose} size="md">
      <DlgForm
        title={`Rebuild ${inst.name}`}
        intro={`Replaces the root disk with a fresh copy of the image. Config, environment, devices, port forwards and attached volumes stay as they are. Anything else written to the root disk is gone.${running ? ` ${inst.name} is stopped first and started again after.` : ""}`}
        confirm="Rebuild"
        danger
        disabled={!ok}
        onClose={onClose}
        onSubmit={() => {
          if (!pick) return;
          onClose();
          const base = `/1.0/instances/${encodeURIComponent(inst.name)}`;
          const o = { project: inst.project };
          const source: any = pick.protocol === "local" ? (/^[0-9a-f]{64}$/.test(pick.alias) ? { type: "image", fingerprint: pick.alias } : { type: "image", alias: pick.alias }) : { type: "image", protocol: pick.protocol, server: pick.server, alias: pick.alias, mode: "pull" };
          app.run(
            `Rebuilding ${inst.name}`,
            async (progress) => {
              if (running) {
                progress("Stopping");
                await incusOp(inst.server, base + "/state", { ...o, method: "PUT", body: { action: "stop", timeout: 30 } }).catch(() => incusOp(inst.server, base + "/state", { ...o, method: "PUT", body: { action: "stop", force: true } }));
              }
              const rebuild = () => incusOp(inst.server, base + "/rebuild", { ...o, method: "POST", body: { source } }, progress);
              try {
                // Try first: Incus checks the image before it looks at snapshots,
                // so a wrong image fails here and no snapshot is lost.
                await rebuild().catch(async (e) => {
                  if (!nSnaps || !/snapshots/i.test(readable(e))) throw e;
                  for (const s of inst.snapshots || []) {
                    progress(`Deleting snapshot ${s.name}`);
                    await incusOp(inst.server, `${base}/snapshots/${encodeURIComponent(s.name)}`, { ...o, method: "DELETE" });
                  }
                  await rebuild();
                });
              } catch (e) {
                // The root disk is untouched when the rebuild fails, so bring the instance back up.
                if (running) await incusOp(inst.server, base + "/state", { ...o, method: "PUT", body: { action: "start" } }).catch(() => {});
                throw new Error(readable(e));
              }
              if (pick.protocol !== "local" || !/^[0-9a-f]{64}$/.test(pick.alias)) await incusOp(inst.server, base, { ...o, method: "PATCH", body: { config: { "user.incus-webui.source": JSON.stringify(pick) } } }).catch(() => {});
              if (running) {
                progress("Starting");
                await setState(inst.server, inst.project, inst.name, { action: "start" });
              }
              done();
            },
            `${inst.name} rebuilt`,
          );
        }}
      >
        {same && (
          <Seg
            label="Image"
            value={mode}
            onChange={setMode}
            options={[
              { v: "same", l: "Newest of the same image" },
              { v: "other", l: "Another image or tag" },
            ]}
          />
        )}
        {mode === "same" && same && <p className="dlg-note">Pulls {describeSource(same)} again, so it gets the newest version.</p>}
        {!same && <p className="dlg-note">{known.src ? "Filled in from what the instance knows about its image. Check it before you rebuild." : "This UI didn't create the instance, so pick the image to rebuild it from."}</p>}
        {mode === "other" && (
          <>
            <Field label="From">
              <Seg
                label="Image source"
                value={kind}
                onChange={changeKind}
                options={[
                  ...(inst.type === "container" ? [{ v: "oci" as const, l: "OCI registry" }] : []),
                  { v: "simplestreams" as const, l: "Image server" },
                  { v: "local" as const, l: "On this server" },
                ]}
              />
            </Field>
            {kind === "local" ? (
              <Field label="Image">
                <Select value={alias} onChange={setAlias} options={[{ v: "", l: local.data ? (localOpts.length ? "Choose an image" : "No images of this type here") : "Loading…" }, ...localOpts]} />
              </Field>
            ) : (
              <div className="two">
                <Field label={kind === "oci" ? "Registry" : "Image server"}>
                  <Select value={curServer} onChange={setServer} options={srvOpts.length ? srvOpts : [{ v: curServer, l: curServer || "None" }]} />
                </Field>
                <Field label={kind === "oci" ? "Image and tag" : "Image"} hint={kind === "oci" ? "Change the tag to move to another version." : undefined}>
                  <Input mono value={alias} onChange={setAlias} placeholder={kind === "oci" ? ociRegistries.find((r) => r.url === curServer)?.hint : "debian/12/cloud"} />
                </Field>
              </div>
            )}
          </>
        )}
        {nSnaps > 0 && (
          <label className="check-row">
            <input type="checkbox" checked={delSnaps} onChange={(e) => setDelSnaps(e.target.checked)} />
            <span>
              Delete its {nSnaps} snapshot{nSnaps === 1 ? "" : "s"}
              <small>Incus can't rebuild an instance that has snapshots. Back it up first if you want a way back.</small>
            </span>
          </label>
        )}
      </DlgForm>
    </Dialog>
  );
}

// ---------- create image ----------

export function PublishDialog({ inst, open, onClose }: { inst: Inst; open: boolean; onClose: () => void }) {
  const app = useApp();
  const [alias, setAlias] = useState("");
  const running = inst.status !== "Stopped";
  return (
    <Dialog open={open} onClose={onClose} size="sm">
      <DlgForm
        title="Create image"
        intro={running ? `Saves a copy of ${inst.name} as an image to create new instances from. Stop the instance first if this fails.` : `Saves a copy of ${inst.name} as an image to create new instances from.`}
        confirm="Create image"
        onClose={onClose}
        onSubmit={() => {
          onClose();
          const body: any = { source: { type: "instance", name: inst.name }, aliases: alias ? [{ name: alias }] : [], public: false };
          app.run(
            `Creating image from ${inst.name}`,
            async (progress) => {
              try {
                await incusOp(inst.server, "/1.0/images", { method: "POST", project: inst.project, body }, progress);
              } catch (e) {
                throw new Error(/already exists|alias/i.test(String((e as Error).message)) ? `The alias "${alias}" is already used. Pick another one.` : readable(e));
              }
              invalidate("images");
            },
            alias ? `Image ${alias} created` : "Image created",
          );
        }}
      >
        <Field label="Alias (optional)" hint="A short name to find the image by.">
          <div className="field">
            <input autoFocus placeholder="web-base" value={alias} onChange={(e) => setAlias(e.target.value.trim())} />
          </div>
        </Field>
      </DlgForm>
    </Dialog>
  );
}

// ---------- snapshots: rename, new instance ----------

export function SnapRenameDialog({ inst, snap, onClose, reload }: { inst: Inst; snap: string | null; onClose: () => void; reload: () => void }) {
  const app = useApp();
  const [name, setName] = useState(snap || "");
  const taken = (inst.snapshots || []).map((s) => s.name);
  const bad = nameProblem(name, taken);
  return (
    <Dialog open={!!snap} onClose={onClose} size="sm">
      {snap && (
        <DlgForm
          title="Rename snapshot"
          confirm="Rename"
          disabled={!name || name === snap || !!bad}
          onClose={onClose}
          onSubmit={() => {
            onClose();
            app.run(
              `Renaming ${snap}`,
              async () => {
                try {
                  await incusOp(inst.server, `/1.0/instances/${encodeURIComponent(inst.name)}/snapshots/${encodeURIComponent(snap)}`, { method: "POST", project: inst.project, body: { name } });
                } catch (e) {
                  throw new Error(readable(e));
                }
                reload();
              },
              `Snapshot renamed to ${name}`,
            );
          }}
        >
          <Field label="New name" hint={bad} bad>
            <div className="field">
              <input autoFocus value={name} onChange={(e) => setName(e.target.value.trim())} />
            </div>
          </Field>
        </DlgForm>
      )}
    </Dialog>
  );
}

export function FromSnapDialog({ inst, snap, onClose, onDone }: { inst: Inst; snap: string | null; onClose: () => void; onDone: (name: string) => void }) {
  const app = useApp();
  const [name, setName] = useState(snap ? `${inst.name}-${snap}` : "");
  const taken = useNames(inst.server, "instances" as any, inst.project).data || [];
  const bad = nameProblem(name, taken);
  return (
    <Dialog open={!!snap} onClose={onClose} size="sm">
      {snap && (
        <DlgForm
          title="Create instance from snapshot"
          intro={`Makes a new instance from ${snap}. ${inst.name} is not changed.`}
          confirm="Create"
          disabled={!name || !!bad}
          onClose={onClose}
          onSubmit={() => {
            onClose();
            app
              .run(
                `Creating ${name}`,
                async (progress) => {
                  try {
                    await incusOp(inst.server, "/1.0/instances", { method: "POST", project: inst.project, body: { name, profiles: inst.profiles, source: { type: "copy", source: `${inst.name}/${snap}`, project: inst.project } } }, progress);
                  } catch (e) {
                    throw new Error(readable(e));
                  }
                  done();
                  return true;
                },
                `${name} created`,
              )
              .then((ok) => ok && onDone(name));
          }}
        >
          <Field label="Name of the new instance" hint={bad} bad>
            <div className="field">
              <input autoFocus value={name} onChange={(e) => setName(e.target.value.trim())} />
            </div>
          </Field>
        </DlgForm>
      )}
    </Dialog>
  );
}
