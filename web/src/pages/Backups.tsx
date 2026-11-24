import { useEffect, useState } from "react";
import { bytes, dateTime, friendlyError, ui, type Instance } from "../api";
import { invalidate, useApp, useData } from "../state";
import { confirmDialog, Dialog, Input, Select, Table, TglRow } from "../ui";
import { useNames } from "../data";
import { DlgForm, F, nameProblem } from "./InstanceDialogs";

type Meta = { key: string; target: string; server: string; project: string; instance: string; type: string; created: string; size: number; sha256: string; schedule?: string; by?: string };
type TargetName = { name: string; type: string };

// The backups of one instance, on every target.
export function BackupsTab({ inst }: { inst: Instance & { server: string } }) {
  const app = useApp();
  const canManage = app.can(inst.server, inst.project, "manager");
  const qs = new URLSearchParams({ project: inst.project, instance: inst.name });
  const q = useData<{ backups: Meta[]; errors: string[] | null }>(`backups:${inst.server}:${qs}`, () => ui(`/backups/${encodeURIComponent(inst.server)}?${qs}`), 30000);
  const targets = useData<TargetName[]>("ui-backup-targets", () => ui("/backup-targets"));
  const [target, setTarget] = useState("");
  const tgt = target || targets.data?.[0]?.name || "";
  const [restore, setRestore] = useState<Meta | null>(null);

  const backup = async () => {
    try {
      await ui(`/backups/${encodeURIComponent(inst.server)}`, { method: "POST", body: { project: inst.project, instance: inst.name, target: tgt } });
      invalidate("ui-jobs");
      app.toast(`Backing up ${inst.name}. Follow it under Tasks.`);
    } catch (e) {
      app.fail(e, "Couldn't start the backup.");
    }
  };
  const del = async (m: Meta) => {
    const ok = await confirmDialog({ title: "Delete backup", body: `Delete the backup of ${m.instance} from ${dateTime(m.created)} on ${m.target}? This can't be undone.`, confirm: "Delete", danger: true });
    if (!ok) return;
    try {
      await ui(`/backup?${new URLSearchParams({ target: m.target, key: m.key })}`, { method: "DELETE" });
      invalidate("backups:");
    } catch (e) {
      app.fail(e, "Couldn't delete the backup.");
    }
  };
  const dl = (m: Meta) => `/api/ui/backup/download?${new URLSearchParams({ target: m.target, key: m.key })}`;

  return (
    <div className="panel bk">
      <div className="ptitle">
        <h2>Backups</h2>
        {canManage && targets.data && targets.data.length > 0 && (
          <span className="r">
            {targets.data.length > 1 && <Select aria-label="Backup target" value={tgt} onChange={setTarget} options={targets.data.map((t) => t.name)} />}
            <button className="btn btn-p btn-sm press" onClick={backup}>
              Back up now
            </button>
          </span>
        )}
      </div>
      {targets.data && targets.data.length === 0 && <p className="dim">{app.admin ? "Add a backup target under Settings, Backups, to back up instances." : "No backup target is set up yet. Ask an admin to add one."}</p>}
      {q.data?.errors?.map((e) => (
        <p key={e} className="bad">
          {e}
        </p>
      ))}
      <Table
        rows={q.data?.backups}
        loading={!q.data && !q.error}
        rowKey={(m) => m.target + m.key}
        initial={{ k: "created", asc: false }}
        empty={q.error ? friendlyError(q.error) : "No backups of this instance yet."}
        cols={[
          { k: "created", label: "Made", cell: (m) => dateTime(m.created), sort: (m) => m.created },
          { k: "target", label: "Target", cell: (m) => m.target, sort: (m) => m.target },
          { k: "size", label: "Size", cls: "num", cell: (m) => bytes(m.size), sort: (m) => m.size },
          { k: "by", label: "By", cell: (m) => (m.schedule ? `Schedule ${m.schedule}` : m.by || ""), sort: (m) => m.schedule || m.by },
          {
            k: "act",
            label: "",
            cls: "act",
            hide: !canManage,
            cell: (m) => (
              <span className="bk-act">
                <button className="lnk" onClick={() => setRestore(m)}>
                  Restore
                </button>
                <a className="lnk" href={dl(m)} download>
                  Download
                </a>
                <button className="lnk" onClick={() => del(m)}>
                  Delete
                </button>
              </span>
            ),
          },
        ]}
      />
      <RestoreDialog m={restore} onClose={() => setRestore(null)} />
    </div>
  );
}

function RestoreDialog({ m, onClose }: { m: Meta | null; onClose: () => void }) {
  const app = useApp();
  const [name, setName] = useState("");
  const [project, setProject] = useState("");
  useEffect(() => {
    if (m) {
      setName(`${m.instance}-restored`);
      setProject(m.project);
    }
  }, [m]);
  const projects = (useNames(m?.server || "", "projects").data || []).filter((p) => m && app.can(m.server, p, "manager"));
  const taken = useNames(m?.server || "", "instances" as any, project).data || [];
  const bad = nameProblem(name, taken);
  return (
    <Dialog open={!!m} onClose={onClose} size="sm">
      {m && (
        <DlgForm
          title="Restore backup"
          intro={`Makes a new instance from the backup of ${m.instance} made ${dateTime(m.created)}. The original stays as it is. The backup's checksum is checked on the way.`}
          confirm="Restore"
          disabled={!name || !!bad}
          onClose={onClose}
          onSubmit={async () => {
            try {
              await ui("/backup/restore", { method: "POST", body: { target: m.target, key: m.key, server: m.server, project, name } });
              invalidate("ui-jobs");
              app.toast(`Restoring as ${name}. Follow it under Tasks.`);
              onClose();
            } catch (e) {
              app.fail(e, "Couldn't start the restore.");
            }
          }}
        >
          <F label="New name" hint={bad} bad>
            <div className="field">
              <input className="mono" autoFocus value={name} onChange={(e) => setName(e.target.value.trim())} />
            </div>
          </F>
          <F label="Project">
            <Select value={project} onChange={setProject} options={projects.length ? projects : [project]} />
          </F>
        </DlgForm>
      )}
    </Dialog>
  );
}

// ---------- Settings: targets and schedules ----------

type Target = { name: string; type: "dir" | "s3"; path?: string; endpoint?: string; bucket?: string; region?: string; prefix?: string; access_key?: string; secret_key?: string; virtual_host?: boolean };
type SchedState = { last_run?: string; last_ok: boolean; last_error?: string; running: boolean };
type Schedule = { name: string; server: string; project: string; instances: string[] | null; target: string; at: string; keep_daily: number; keep_weekly: number; test_restore: boolean; paused: boolean; state?: SchedState };
type PBS = { name: string; url: string; datastore: string; namespace?: string; token_id: string; secret: string; fingerprint?: string };
type Conf = { targets: Target[]; schedules: Schedule[]; pbs: PBS[] };

export function BackupSettings() {
  const app = useApp();
  const q = useData<Conf>("ui-backup-config", () => ui("/backup-config"), 15000);
  const [draft, setDraft] = useState<Conf | null>(null);
  const [err, setErr] = useState("");
  const [testing, setTesting] = useState("");
  const conf = draft || q.data;
  if (!conf) return null;
  const strip = (c: Conf) => JSON.stringify({ targets: c.targets, schedules: c.schedules.map(({ state: _s, ...s }) => s), pbs: c.pbs });
  const dirty = !!draft && !!q.data && strip(draft) !== strip(q.data);
  const edit = (f: (c: Conf) => Conf) => {
    setErr("");
    setDraft(f(structuredClone(conf)));
  };
  const setT = (i: number, p: Partial<Target>) => edit((c) => ((c.targets[i] = { ...c.targets[i], ...p }), c));
  const setS = (i: number, p: Partial<Schedule>) => edit((c) => ((c.schedules[i] = { ...c.schedules[i], ...p }), c));
  const setP = (i: number, p: Partial<PBS>) => edit((c) => ((c.pbs[i] = { ...c.pbs[i], ...p }), c));
  const save = async () => {
    try {
      await ui("/backup-config", { method: "PUT", body: { targets: conf.targets, schedules: conf.schedules.map(({ state: _s, ...s }) => s), pbs: conf.pbs } });
      app.toast("Backup settings saved");
      setDraft(null);
      invalidate("ui-backup");
    } catch (e) {
      setErr(friendlyError(e));
    }
  };
  const test = async (t: Target) => {
    setTesting(t.name);
    try {
      await ui("/backup-targets/test", { method: "POST", body: t });
      app.toast(`${t.name} works: the UI wrote, read and deleted a test file.`);
    } catch (e) {
      app.fail(e, `${t.name} doesn't work.`);
    } finally {
      setTesting("");
    }
  };
  const testPBS = async (p: PBS) => {
    setTesting("pbs:" + p.name);
    try {
      const r = await ui<{ snapshots: number }>("/pbs/test", { method: "POST", body: p });
      app.toast(`${p.name} works: ${r.snapshots} VM and container backup${r.snapshots === 1 ? "" : "s"} found.`);
    } catch (e) {
      app.fail(e, `${p.name} doesn't work.`);
    } finally {
      setTesting("");
    }
  };
  const run = async (s: Schedule) => {
    try {
      await ui(`/backup-schedules/${encodeURIComponent(s.name)}/run`, { method: "POST" });
      invalidate("ui-jobs");
      invalidate("ui-backup-config");
      app.toast(`Running ${s.name}. Follow it under Tasks.`);
    } catch (e) {
      app.fail(e, "Couldn't run the schedule.");
    }
  };
  const servers = app.servers.map((s) => s.name);

  return (
    <>
      <section className="set-sec">
        <h2>Backup targets</h2>
        <p>Where backups go: a directory on the machine that runs the UI (a mounted NAS share works), or an S3 bucket. Each backup has a SHA-256 checksum that a restore checks.</p>
        {conf.targets.map((t, i) => (
          <div className="panel bk-card" key={i}>
            <div className="two">
              <F label="Name">
                <Input mono value={t.name} onChange={(v) => setT(i, { name: v })} placeholder="nas" />
              </F>
              <F label="Type">
                <Select value={t.type} onChange={(v) => setT(i, { type: v as Target["type"] })} options={[{ v: "dir", l: "Directory" }, { v: "s3", l: "S3 bucket" }]} />
              </F>
              {t.type === "dir" ? (
                <F label="Directory" hint="An absolute path the UI can write to. When the UI runs as an Incus instance, add a disk device for it.">
                  <Input mono value={t.path || ""} onChange={(v) => setT(i, { path: v })} placeholder="/mnt/backups" />
                </F>
              ) : (
                <>
                  <F label="Endpoint">
                    <Input mono value={t.endpoint || ""} onChange={(v) => setT(i, { endpoint: v })} placeholder="https://s3.eu-central-1.amazonaws.com" />
                  </F>
                  <F label="Bucket">
                    <Input mono value={t.bucket || ""} onChange={(v) => setT(i, { bucket: v })} />
                  </F>
                  <F label="Region" hint="Leave empty for us-east-1, which MinIO and Garage accept.">
                    <Input mono value={t.region || ""} onChange={(v) => setT(i, { region: v })} />
                  </F>
                  <F label="Folder in the bucket">
                    <Input mono value={t.prefix || ""} onChange={(v) => setT(i, { prefix: v })} placeholder="incus" />
                  </F>
                  <F label="Access key">
                    <Input mono value={t.access_key || ""} onChange={(v) => setT(i, { access_key: v })} />
                  </F>
                  <F label="Secret key">
                    <Input mono type="password" value={t.secret_key || ""} onChange={(v) => setT(i, { secret_key: v })} />
                  </F>
                </>
              )}
            </div>
            <div className="roles-f">
              <button className="btn btn-q btn-sm" onClick={() => edit((c) => ((c.targets = c.targets.filter((_, j) => j !== i)), c))}>
                Remove
              </button>
              <span className="r">
                <button className="btn btn-s btn-sm press" disabled={!!testing} onClick={() => test(t)}>
                  {testing === t.name ? "Testing…" : "Test"}
                </button>
              </span>
            </div>
          </div>
        ))}
        <button className="btn btn-q btn-sm" onClick={() => edit((c) => (c.targets.push({ name: c.targets.length ? `target${c.targets.length + 1}` : "backups", type: "dir", path: "" }), c))}>
          Add target
        </button>
      </section>

      <section className="set-sec">
        <h2>Schedules</h2>
        <p>Each schedule backs up a project, or some of its instances, once a day. It keeps the newest backup of each of the last days and weeks you choose, and never touches backups made by hand.</p>
        {conf.schedules.map((s, i) => (
          <div className="panel bk-card" key={i}>
            <div className="two">
              <F label="Name">
                <Input mono value={s.name} onChange={(v) => setS(i, { name: v })} />
              </F>
              <F label="Target">
                <Select value={s.target} onChange={(v) => setS(i, { target: v })} options={conf.targets.map((t) => t.name)} />
              </F>
              <F label="Server">
                <Select value={s.server} onChange={(v) => setS(i, { server: v })} options={servers.includes(s.server) ? servers : [...servers, s.server]} />
              </F>
              <F label="Project">
                <Input mono value={s.project} onChange={(v) => setS(i, { project: v })} placeholder="default" />
              </F>
              <F label="Instances" hint="Separate with commas. Leave empty for every instance in the project.">
                <Input
                  mono
                  value={(s.instances || []).join(", ")}
                  onChange={(v) =>
                    setS(i, {
                      instances: v
                        .split(",")
                        .map((x) => x.trim())
                        .filter(Boolean),
                    })
                  }
                />
              </F>
              <F label="Time" hint="Every day, in the time zone of the machine that runs the UI.">
                <Input mono value={s.at} onChange={(v) => setS(i, { at: v })} placeholder="03:00" />
              </F>
              <F label="Keep daily">
                <Input mono inputMode="numeric" value={String(s.keep_daily)} onChange={(v) => setS(i, { keep_daily: parseInt(v) || 0 })} />
              </F>
              <F label="Keep weekly">
                <Input mono inputMode="numeric" value={String(s.keep_weekly)} onChange={(v) => setS(i, { keep_weekly: parseInt(v) || 0 })} />
              </F>
            </div>
            <TglRow title="Test restore on Sundays" note="Restores Sunday's backups under a temporary name and deletes them again, to prove they work." on={s.test_restore} onChange={(v) => setS(i, { test_restore: v })} />
            <TglRow title="Paused" on={s.paused} onChange={(v) => setS(i, { paused: v })} />
            <div className="roles-f">
              <button className="btn btn-q btn-sm" onClick={() => edit((c) => ((c.schedules = c.schedules.filter((_, j) => j !== i)), c))}>
                Remove
              </button>
              <span className={"bk-st" + (s.state?.last_run && !s.state.last_ok && !s.state.running ? " bad" : "")}>{schedStatus(s.state)}</span>
              <span className="r">
                <button className="btn btn-s btn-sm press" disabled={dirty || s.state?.running} title={dirty ? "Save first" : undefined} onClick={() => run(s)}>
                  Run now
                </button>
              </span>
            </div>
          </div>
        ))}
        <button
          className="btn btn-q btn-sm"
          disabled={conf.targets.length === 0}
          onClick={() => edit((c) => (c.schedules.push({ name: `daily${c.schedules.length || ""}`, server: servers[0] || "", project: "default", instances: [], target: c.targets[0].name, at: "03:00", keep_daily: 7, keep_weekly: 4, test_restore: false, paused: false }), c))}
        >
          Add schedule
        </button>
      </section>
      <section className="set-sec">
        <h2>Proxmox Backup Servers</h2>
        <p>
          Import VMs and containers straight from a Proxmox Backup Server: the UI downloads the backup itself. Make an API token in PBS (Configuration, Access Control, API Token) and give it the DatastoreReader role on the datastore. Encrypted backups can't be imported.
        </p>
        {(conf.pbs || []).map((p, i) => (
          <div className="panel bk-card" key={i}>
            <div className="two">
              <F label="Name">
                <Input mono value={p.name} onChange={(v) => setP(i, { name: v })} placeholder="pbs" />
              </F>
              <F label="Address">
                <Input mono value={p.url} onChange={(v) => setP(i, { url: v })} placeholder="https://pbs.lan:8007" />
              </F>
              <F label="Datastore">
                <Input mono value={p.datastore} onChange={(v) => setP(i, { datastore: v })} />
              </F>
              <F label="Namespace" hint="Leave empty for the root namespace.">
                <Input mono value={p.namespace || ""} onChange={(v) => setP(i, { namespace: v })} />
              </F>
              <F label="API token ID">
                <Input mono value={p.token_id} onChange={(v) => setP(i, { token_id: v })} placeholder="root@pam!incus" />
              </F>
              <F label="Secret">
                <Input mono type="password" value={p.secret} onChange={(v) => setP(i, { secret: v })} />
              </F>
              <F label="Fingerprint" hint="From the PBS dashboard (Show Fingerprint). Needed when PBS uses its own self-signed certificate.">
                <Input mono value={p.fingerprint || ""} onChange={(v) => setP(i, { fingerprint: v })} />
              </F>
            </div>
            <div className="roles-f">
              <button className="btn btn-q btn-sm" onClick={() => edit((c) => ((c.pbs = c.pbs.filter((_, j) => j !== i)), c))}>
                Remove
              </button>
              <span className="r">
                <button className="btn btn-s btn-sm press" disabled={!!testing} onClick={() => testPBS(p)}>
                  {testing === "pbs:" + p.name ? "Testing…" : "Test"}
                </button>
              </span>
            </div>
          </div>
        ))}
        <button className="btn btn-q btn-sm" onClick={() => edit((c) => ((c.pbs = [...(c.pbs || []), { name: c.pbs?.length ? `pbs${c.pbs.length + 1}` : "pbs", url: "", datastore: "", token_id: "", secret: "" }]), c))}>
          Add backup server
        </button>
      </section>
      {(dirty || err) && (
        <div className="bk-save">
          {err && <span className="bad">{err}</span>}
          <span className="r">
            <button className="btn btn-q btn-sm" onClick={() => (setDraft(null), setErr(""))}>
              Discard
            </button>
            <button className="btn btn-p btn-sm press" disabled={!dirty} onClick={save}>
              Save backup settings
            </button>
          </span>
        </div>
      )}
    </>
  );
}

function schedStatus(s?: SchedState) {
  if (!s?.last_run) return "Not run yet";
  if (s.running) return "Running";
  return s.last_ok ? `Last run ${dateTime(s.last_run)}` : `Failed ${dateTime(s.last_run)}: ${s.last_error}`;
}
