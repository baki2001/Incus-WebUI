import { useState } from "react";
import { friendlyError, incusOp, type Instance } from "../api";
import { useNames } from "../data";
import { invalidate, useApp } from "../state";
import { Dialog, Select } from "../ui";

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
            <button type="submit" className="btn btn-p press" autoFocus>
              {force || a.allFrozen ? "Force stop" : "Stop"}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

// ---------- small form shell ----------

function DlgForm({ title, intro, confirm, disabled, onClose, onSubmit, children }: { title: string; intro?: string; confirm: string; disabled?: boolean; onClose: () => void; onSubmit: () => void; children: React.ReactNode }) {
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
        <button type="submit" className="btn btn-p press" disabled={disabled}>
          {confirm}
        </button>
      </div>
    </form>
  );
}

function F({ label, hint, bad, children }: { label: string; hint?: React.ReactNode; bad?: boolean; children: React.ReactNode }) {
  return (
    <div className="fl">
      <label>{label}</label>
      {children}
      {hint && <div className={"hint" + (bad ? " bad" : "")}>{hint}</div>}
    </div>
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
const done = (app: ReturnType<typeof useApp>) => {
  invalidate("instances:");
  invalidate("instance:");
  app.touch();
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
                done(app);
                return true;
              },
              `Renamed to ${name}`,
            )
            .then((ok) => ok && onDone(name));
        }}
      >
        <F label="New name" hint={bad} bad>
          <div className="field">
            <input className="mono" autoFocus value={name} onChange={(e) => setName(e.target.value.trim())} />
          </div>
        </F>
      </DlgForm>
    </Dialog>
  );
}

// ---------- copy ----------

export function CopyDialog({ inst, open, onClose, onDone }: { inst: Inst; open: boolean; onClose: () => void; onDone: (name: string, project: string) => void }) {
  const app = useApp();
  const projects = useNames(inst.server, "projects").data || [inst.project];
  const pools = useNames(inst.server, "storage-pools").data || [];
  const [name, setName] = useState(`${inst.name}-copy`);
  const [project, setProject] = useState(inst.project);
  const [pool, setPool] = useState("");
  const [snaps, setSnaps] = useState(false);
  const taken = useNames(inst.server, "instances" as any, project).data || [];
  const bad = nameProblem(name, taken);
  const nSnaps = inst.snapshots?.length || 0;
  return (
    <Dialog open={open} onClose={onClose} size="sm">
      <DlgForm
        title="Copy instance"
        intro="Makes a new instance from the current disk. A running instance is copied without its memory."
        confirm="Copy"
        disabled={!name || !!bad}
        onClose={onClose}
        onSubmit={() => {
          onClose();
          const body: any = { name, profiles: inst.profiles, source: { type: "copy", source: inst.name, project: inst.project, live: false, instance_only: !snaps } };
          if (pool) body.devices = { root: { ...(inst.expanded_devices?.root || { type: "disk", path: "/" }), pool } };
          app
            .run(
              `Copying ${inst.name}`,
              async (progress) => {
                try {
                  await incusOp(inst.server, "/1.0/instances", { method: "POST", project, body }, progress);
                } catch (e) {
                  throw new Error(readable(e));
                }
                done(app);
                return true;
              },
              `Copied to ${name}`,
            )
            .then((ok) => ok && onDone(name, project));
        }}
      >
        <F label="New name" hint={bad} bad>
          <div className="field">
            <input className="mono" autoFocus value={name} onChange={(e) => setName(e.target.value.trim())} />
          </div>
        </F>
        <F label="Project">
          <Select value={project} onChange={setProject} options={projects} />
        </F>
        <F label="Storage pool">
          <Select value={pool} onChange={setPool} options={[{ v: "", l: `Same as the original (${rootPool(inst) || "default"})` }, ...pools.filter((p) => p !== rootPool(inst)).map((p) => ({ v: p, l: p }))]} />
        </F>
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

export function MoveDialog({ inst, open, onClose, onDone }: { inst: Inst; open: boolean; onClose: () => void; onDone: (project: string) => void }) {
  const app = useApp();
  const projects = useNames(inst.server, "projects").data || [inst.project];
  const pools = useNames(inst.server, "storage-pools").data || [];
  const [project, setProject] = useState(inst.project);
  const [pool, setPool] = useState(rootPool(inst));
  const same = project === inst.project && pool === rootPool(inst);
  const taken = useNames(inst.server, "instances" as any, project).data || [];
  const clash = project !== inst.project && taken.includes(inst.name);
  return (
    <Dialog open={open} onClose={onClose} size="sm">
      <DlgForm
        title="Move instance"
        intro="The instance has to be stopped. It keeps its name and data."
        confirm="Move"
        disabled={same || clash}
        onClose={onClose}
        onSubmit={() => {
          onClose();
          const body: any = { name: inst.name, migration: true };
          if (project !== inst.project) body.project = project;
          if (pool !== rootPool(inst)) body.pool = pool;
          app
            .run(
              `Moving ${inst.name}`,
              async (progress) => {
                try {
                  await incusOp(inst.server, `/1.0/instances/${encodeURIComponent(inst.name)}`, { method: "POST", project: inst.project, body }, progress);
                } catch (e) {
                  throw new Error(readable(e));
                }
                done(app);
                return true;
              },
              `${inst.name} moved`,
            )
            .then((ok) => ok && onDone(project));
        }}
      >
        <F label="Project" hint={clash ? `${project} already has an instance named ${inst.name}.` : undefined} bad>
          <Select value={project} onChange={setProject} options={projects} />
        </F>
        <F label="Storage pool">
          <Select value={pool} onChange={setPool} options={pools.length ? pools : [pool]} />
        </F>
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
        <F label="Alias (optional)" hint="A short name to find the image by.">
          <div className="field">
            <input className="mono" autoFocus placeholder="web-base" value={alias} onChange={(e) => setAlias(e.target.value.trim())} />
          </div>
        </F>
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
          <F label="New name" hint={bad} bad>
            <div className="field">
              <input className="mono" autoFocus value={name} onChange={(e) => setName(e.target.value.trim())} />
            </div>
          </F>
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
                  done(app);
                  return true;
                },
                `${name} created`,
              )
              .then((ok) => ok && onDone(name));
          }}
        >
          <F label="Name of the new instance" hint={bad} bad>
            <div className="field">
              <input className="mono" autoFocus value={name} onChange={(e) => setName(e.target.value.trim())} />
            </div>
          </F>
        </DlgForm>
      )}
    </Dialog>
  );
}
