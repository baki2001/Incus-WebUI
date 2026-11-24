import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { bytes, dateTime, friendlyError, incus, ui, type Instance } from "../api";
import { ic } from "../icons";
import { useCrumbs } from "../Shell";
import { invalidate, useApp, useData, useScopedServers } from "../state";
import { confirmDialog, Dialog, Empty, Field, Input, Seg, Select, Table, TglRow, useOutside, usePresence } from "../ui";
import { useNames } from "../data";
import { DlgForm, nameProblem } from "./InstanceDialogs";
import { matches, PageHead, Search } from "./Resource";

export type Meta = { key: string; target: string; server: string; project: string; instance: string; type: string; created: string; size: number; sha256: string; schedule?: string; by?: string; name?: string };
export type TargetName = { name: string; type: string };

export function useBackupTargets() {
  return useData<TargetName[]>("ui-backup-targets", () => ui("/backup-targets"));
}

const dlUrl = (m: Meta) => `/api/ui/backup/download?${new URLSearchParams({ target: m.target, key: m.key })}`;
const madeBy = (m: Meta) => (m.schedule ? `Schedule ${m.schedule}` : m.by || "");

async function deleteBackup(app: ReturnType<typeof useApp>, m: Meta) {
  const ok = await confirmDialog({ title: "Delete backup", body: `Delete the backup of ${m.instance} from ${dateTime(m.created)} on ${m.target}? This can't be undone.`, confirm: "Delete", danger: true });
  if (!ok) return;
  try {
    await ui(`/backup?${new URLSearchParams({ target: m.target, key: m.key })}`, { method: "DELETE" });
    invalidate("backups:");
  } catch (e) {
    app.fail(e, "Couldn't delete the backup.");
  }
}

function BackupActions({ m, onRestore }: { m: Meta; onRestore: (m: Meta) => void }) {
  const app = useApp();
  return (
    <div className="qa" style={{ opacity: 1 }}>
      <button className="btn btn-q btn-sm" onClick={() => onRestore(m)}>
        Restore
      </button>
      <a className="btn btn-q ib btn-sm" aria-label="Download" title="Download" href={dlUrl(m)} download>
        {ic.dl}
      </a>
      <button className="btn btn-q ib btn-sm" aria-label="Delete" title="Delete" onClick={() => deleteBackup(app, m)}>
        {ic.trash}
      </button>
    </div>
  );
}

// ---------- the Backups page: every backup on every target ----------

export function BackupsPage() {
  useCrumbs([{ label: "Backups" }]);
  const app = useApp();
  const servers = useScopedServers();
  const multi = app.servers.length > 1;
  const allProjects = app.project === "*";
  const names = servers.map((s) => s.name).join(",");
  const q = useData<{ backups: Meta[]; errors: string[] }>(names ? `backups:all:${names}:${app.project}` : null, async () => {
    const res = await Promise.all(
      servers.map((s) =>
        ui<{ backups: Meta[]; errors: string[] | null }>(`/backups/${encodeURIComponent(s.name)}?${new URLSearchParams({ project: app.project })}`).catch((e) => ({ backups: [] as Meta[], errors: [`${s.name}: ${friendlyError(e)}`] })),
      ),
    );
    return { backups: res.flatMap((r) => r.backups || []), errors: [...new Set(res.flatMap((r) => r.errors || []))] };
  }, 30000);
  const targets = useBackupTargets();
  const [search, setSearch] = useState("");
  const [target, setTarget] = useState("");
  const [restore, setRestore] = useState<Meta | null>(null);
  const rows = q.data?.backups.filter((m) => (!target || m.target === target) && matches(search, m.instance, m.name, m.project, m.by, m.schedule));
  const anyManage = (q.data?.backups || []).some((m) => app.can(m.server, m.project, "manager"));
  const noTargets = targets.data && targets.data.length === 0;

  return (
    <>
      <PageHead title="Backups">
        {app.admin && (
          <Link to="/settings/backups" className="btn btn-s press" style={{ textDecoration: "none" }}>
            {ic.gear}Targets and schedules
          </Link>
        )}
      </PageHead>
      {noTargets ? (
        <div className="panel">
          <Empty title="No backup targets yet">
            {app.admin ? (
              <>
                <Link to="/settings/backups">Add one under Settings, Backups</Link>, then back up instances from their Backups or Snapshots tab, or with a schedule.
              </>
            ) : (
              "No backup target is set up yet. Ask an admin to add one."
            )}
          </Empty>
        </div>
      ) : (
        <>
          <div className="fbar">
            <Search value={search} onChange={setSearch} placeholder="Filter by instance, name or project" />
            {targets.data && targets.data.length > 1 && <Select aria-label="Backup target" value={target} onChange={setTarget} options={[{ v: "", l: "All targets" }, ...targets.data.map((t) => ({ v: t.name, l: t.name }))]} />}
            <span className="dim fnote">Backups and snapshots kept on your backup targets. A restore makes a new instance; the original stays as it is.</span>
          </div>
          {q.data?.errors?.map((e) => (
            <div key={e} className="note-box bad">
              {e}
            </div>
          ))}
          <Table<Meta>
            rows={rows}
            loading={!q.data && !q.error}
            rowKey={(m) => m.target + m.key}
            initial={{ k: "created", asc: false }}
            empty={q.error ? friendlyError(q.error) : search || target ? "No backups match." : "No backups yet."}
            cols={[
              {
                k: "instance",
                label: "Instance",
                sort: (m) => m.instance,
                cell: (m) => (
                  <Link className="nm2" style={{ textDecoration: "none" }} to={`/instances/${encodeURIComponent(m.server)}/${encodeURIComponent(m.instance)}?project=${encodeURIComponent(m.project)}`}>
                    {m.instance}
                    {m.name && <span className="tag">{m.name}</span>}
                  </Link>
                ),
              },
              { k: "project", label: "Project", sort: (m) => m.project, cell: (m) => m.project, hide: !allProjects, cls: "hide-s" },
              { k: "server", label: "Server", sort: (m) => m.server, cell: (m) => m.server, hide: !multi, cls: "hide-m" },
              { k: "target", label: "Target", sort: (m) => m.target, cell: (m) => m.target },
              { k: "created", label: "Made", sort: (m) => m.created, cell: (m) => dateTime(m.created) },
              { k: "size", label: "Size", cls: "right hide-s", sort: (m) => m.size, cell: (m) => <span className="mono">{bytes(m.size)}</span> },
              { k: "by", label: "By", sort: madeBy, cell: madeBy, cls: "hide-m" },
              { k: "act", label: "", hide: !anyManage, cell: (m) => (app.can(m.server, m.project, "manager") ? <BackupActions m={m} onRestore={setRestore} /> : null) },
            ]}
          />
        </>
      )}
      <RestoreDialog m={restore} onClose={() => setRestore(null)} />
    </>
  );
}

// The backups of one instance, on every target.
export function BackupsTab({ inst }: { inst: Instance & { server: string } }) {
  const app = useApp();
  const canManage = app.can(inst.server, inst.project, "manager");
  const qs = new URLSearchParams({ project: inst.project, instance: inst.name });
  const q = useData<{ backups: Meta[]; errors: string[] | null }>(`backups:${inst.server}:${qs}`, () => ui(`/backups/${encodeURIComponent(inst.server)}?${qs}`), 30000);
  const targets = useBackupTargets();
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

  return (
    <div className="col">
      {canManage && targets.data && targets.data.length > 0 && (
        <div className="toolbar">
          {targets.data.length > 1 && <Select aria-label="Backup target" value={tgt} onChange={setTarget} options={targets.data.map((t) => t.name)} />}
          <button className="btn btn-s press" onClick={backup}>
            Back up now
          </button>
        </div>
      )}
      {targets.data && targets.data.length === 0 && (
        <div className="panel">
          <Empty title="No backup target">
            {app.admin ? (
              <>
                <Link to="/settings/backups">Add a backup target under Settings, Backups</Link> to back up instances.
              </>
            ) : (
              "No backup target is set up yet. Ask an admin to add one."
            )}
          </Empty>
        </div>
      )}
      {q.data?.errors?.map((e) => (
        <div key={e} className="note-box bad">
          {e}
        </div>
      ))}
      <Table
        rows={q.data?.backups}
        loading={!q.data && !q.error}
        rowKey={(m) => m.target + m.key}
        initial={{ k: "created", asc: false }}
        empty={q.error ? friendlyError(q.error) : "No backups of this instance yet."}
        cols={[
          { k: "created", label: "Made", cell: (m) => (m.name ? <>{dateTime(m.created)}<span className="tag" style={{ marginLeft: 8 }}>{m.name}</span></> : dateTime(m.created)), sort: (m) => m.created },
          { k: "target", label: "Target", cell: (m) => m.target, sort: (m) => m.target },
          { k: "size", label: "Size", cls: "right", cell: (m) => <span className="mono">{bytes(m.size)}</span>, sort: (m) => m.size },
          { k: "by", label: "By", cell: madeBy, sort: madeBy },
          { k: "act", label: "", hide: !canManage, cell: (m) => <BackupActions m={m} onRestore={setRestore} /> },
        ]}
      />
      <RestoreDialog m={restore} onClose={() => setRestore(null)} />
    </div>
  );
}

export function RestoreDialog({ m, onClose }: { m: Meta | null; onClose: () => void }) {
  const app = useApp();
  const [name, setName] = useState("");
  const [project, setProject] = useState("");
  const [pool, setPool] = useState("");
  const projects = (useNames(m?.server || "", "projects").data || []).filter((p) => m && app.can(m.server, p, "manager"));
  const taken = useNames(m?.server || "", "instances" as any, project).data || [];
  const pools = useNames(m?.server || "", "storage-pools", project).data || [];
  const takenLoaded = taken.length > 0;
  useEffect(() => {
    if (m) {
      setName(`${m.instance}-restored`);
      setProject(m.project);
      setPool("");
    }
  }, [m]);
  // When the instance is gone, offer to bring it back under its own name.
  useEffect(() => {
    if (m && takenLoaded && project === m.project && !taken.includes(m.instance)) setName((n) => (n === `${m.instance}-restored` ? m.instance : n));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m, takenLoaded, project]);
  const bad = nameProblem(name, taken);
  return (
    <Dialog open={!!m} onClose={onClose} size="sm">
      {m && (
        <DlgForm
          title="Restore backup"
          intro={`Makes a new instance from the backup of ${m.instance}${m.name ? ` (${m.name})` : ""} made ${dateTime(m.created)}. An instance that still exists stays as it is. The backup's checksum is checked on the way.`}
          confirm="Restore"
          disabled={!name || !!bad}
          onClose={onClose}
          onSubmit={async () => {
            try {
              await ui("/backup/restore", { method: "POST", body: { target: m.target, key: m.key, server: m.server, project, name, pool } });
              invalidate("ui-jobs");
              app.toast(`Restoring as ${name}. Follow it under Tasks.`);
              onClose();
            } catch (e) {
              app.fail(e, "Couldn't start the restore.");
            }
          }}
        >
          <Field label="New name" hint={bad} bad>
            <div className="field">
              <input autoFocus value={name} onChange={(e) => setName(e.target.value.trim())} />
            </div>
          </Field>
          <Field label="Project">
            <Select value={project} onChange={setProject} options={projects.length ? projects : [project]} />
          </Field>
          {pools.length > 1 && (
            <Field label="Storage pool">
              <Select value={pool} onChange={setPool} options={[{ v: "", l: "The one in the backup" }, ...pools.map((p) => ({ v: p, l: p }))]} />
            </Field>
          )}
        </DlgForm>
      )}
    </Dialog>
  );
}

// ---------- Settings: targets and schedules ----------

type Target = { name: string; type: "dir" | "s3"; path?: string; endpoint?: string; bucket?: string; region?: string; prefix?: string; access_key?: string; secret_key?: string; virtual_host?: boolean };
type SchedState = { last_run?: string; last_ok: boolean; last_error?: string; running: boolean };
type Schedule = {
  name: string;
  server: string;
  project: string;
  instances: string[] | null;
  target: string;
  at: string;
  days: number[] | null; // 0 Sunday .. 6 Saturday; empty means every day
  keep_daily: number;
  keep_weekly: number;
  optimized: boolean;
  test_restore: boolean;
  paused: boolean;
  state?: SchedState;
};
type PBS = { name: string; url: string; datastore: string; namespace?: string; token_id: string; secret: string; fingerprint?: string };
type Conf = { targets: Target[]; schedules: Schedule[]; pbs: PBS[] };

export function BackupSettings() {
  const app = useApp();
  const q = useData<Conf>("ui-backup-config", () => ui("/backup-config"), 15000);
  const [draft, setDraft] = useState<Conf | null>(null);
  const [err, setErr] = useState("");
  const [testing, setTesting] = useState("");
  const conf = draft || q.data;
  const strip = (c: Conf) => JSON.stringify({ targets: c.targets, schedules: c.schedules.map(({ state: _s, ...s }) => s), pbs: c.pbs });
  const dirty = !!draft && !!q.data && strip(draft) !== strip(q.data);
  const bar = usePresence(dirty || !!err);
  if (!conf) return null;
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
        <div className="col">
          {conf.targets.map((t, i) => (
            <div className="panel bk-card" style={{ marginBottom: 0 }} key={i}>
              <div className="two">
                <Field label="Name">
                  <Input value={t.name} onChange={(v) => setT(i, { name: v })} placeholder="nas" />
                </Field>
                <Field label="Type">
                  <Select value={t.type} onChange={(v) => setT(i, { type: v as Target["type"] })} options={[{ v: "dir", l: "Directory" }, { v: "s3", l: "S3 bucket" }]} />
                </Field>
                {t.type === "dir" ? (
                  <Field label="Directory" hint="An absolute path the UI can write to. When the UI runs as an Incus instance, add a disk device for it.">
                    <Input mono value={t.path || ""} onChange={(v) => setT(i, { path: v })} placeholder="/mnt/backups" />
                  </Field>
                ) : (
                  <>
                    <Field label="Endpoint">
                      <Input mono value={t.endpoint || ""} onChange={(v) => setT(i, { endpoint: v })} placeholder="https://s3.eu-central-1.amazonaws.com" />
                    </Field>
                    <Field label="Bucket">
                      <Input mono value={t.bucket || ""} onChange={(v) => setT(i, { bucket: v })} />
                    </Field>
                    <Field label="Region" hint="Leave empty for us-east-1, which MinIO and Garage accept.">
                      <Input mono value={t.region || ""} onChange={(v) => setT(i, { region: v })} />
                    </Field>
                    <Field label="Folder in the bucket">
                      <Input mono value={t.prefix || ""} onChange={(v) => setT(i, { prefix: v })} placeholder="incus" />
                    </Field>
                    <Field label="Access key">
                      <Input mono value={t.access_key || ""} onChange={(v) => setT(i, { access_key: v })} />
                    </Field>
                    <Field label="Secret key">
                      <Input mono type="password" value={t.secret_key || ""} onChange={(v) => setT(i, { secret_key: v })} />
                    </Field>
                  </>
                )}
              </div>
              <div className="card-f">
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
          <div>
            <button className="btn btn-q btn-sm" onClick={() => edit((c) => (c.targets.push({ name: c.targets.length ? `target${c.targets.length + 1}` : "backups", type: "dir", path: "" }), c))}>
              Add target
            </button>
          </div>
        </div>
      </section>

      <section className="set-sec">
        <h2>Schedules</h2>
        <p>Each schedule backs up a project, or some of its instances, on the days you pick. Old backups the schedule made are deleted as you set under Retention. Backups made by hand are never deleted.</p>
        <div className="col">
          {conf.schedules.map((s, i) => (
            <ScheduleCard
              key={i}
              s={s}
              targets={conf.targets.map((t) => t.name)}
              servers={servers}
              dirty={dirty}
              set={(p) => setS(i, p)}
              remove={() => edit((c) => ((c.schedules = c.schedules.filter((_, j) => j !== i)), c))}
              run={() => run(s)}
            />
          ))}
          <div>
            <button
              className="btn btn-q btn-sm"
              disabled={conf.targets.length === 0}
              onClick={() => edit((c) => (c.schedules.push({ name: `daily${c.schedules.length || ""}`, server: servers[0] || "", project: "default", instances: [], target: c.targets[0].name, at: "03:00", days: [], keep_daily: 7, keep_weekly: 4, optimized: false, test_restore: false, paused: false }), c))}
            >
              Add schedule
            </button>
          </div>
        </div>
      </section>
      <section className="set-sec">
        <h2>Proxmox Backup Servers</h2>
        <p>
          Import VMs and containers straight from a Proxmox Backup Server: the UI downloads the backup itself. Make an API token in PBS (Configuration, Access Control, API Token) and give it the DatastoreReader role on the datastore. Encrypted backups can't be imported.
        </p>
        <div className="col">
          {(conf.pbs || []).map((p, i) => (
            <div className="panel bk-card" style={{ marginBottom: 0 }} key={i}>
              <div className="two">
                <Field label="Name">
                  <Input value={p.name} onChange={(v) => setP(i, { name: v })} placeholder="pbs" />
                </Field>
                <Field label="Address">
                  <Input mono value={p.url} onChange={(v) => setP(i, { url: v })} placeholder="https://pbs.lan:8007" />
                </Field>
                <Field label="Datastore">
                  <Input value={p.datastore} onChange={(v) => setP(i, { datastore: v })} />
                </Field>
                <Field label="Namespace" hint="Leave empty for the root namespace.">
                  <Input mono value={p.namespace || ""} onChange={(v) => setP(i, { namespace: v })} />
                </Field>
                <Field label="API token ID">
                  <Input mono value={p.token_id} onChange={(v) => setP(i, { token_id: v })} placeholder="root@pam!incus" />
                </Field>
                <Field label="Secret">
                  <Input mono type="password" value={p.secret} onChange={(v) => setP(i, { secret: v })} />
                </Field>
                <Field label="Fingerprint" hint="From the PBS dashboard (Show Fingerprint). Needed when PBS uses its own self-signed certificate.">
                  <Input mono value={p.fingerprint || ""} onChange={(v) => setP(i, { fingerprint: v })} />
                </Field>
              </div>
              <div className="card-f">
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
          <div>
            <button className="btn btn-q btn-sm" onClick={() => edit((c) => ((c.pbs = [...(c.pbs || []), { name: c.pbs?.length ? `pbs${c.pbs.length + 1}` : "pbs", url: "", datastore: "", token_id: "", secret: "" }]), c))}>
              Add backup server
            </button>
          </div>
        </div>
      </section>
      {bar.mounted && (
        <div className={"hwbar" + (bar.leaving ? " leaving" : "")}>
          {err ? <span className="bad">{err}</span> : <b>Unsaved changes</b>}
          <button className="btn btn-q btn-sm" onClick={() => (setDraft(null), setErr(""))}>
            Discard
          </button>
          <button className="btn btn-p btn-sm press" disabled={!dirty} onClick={save}>
            Save backup settings
          </button>
        </div>
      )}
    </>
  );
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEK = [1, 2, 3, 4, 5, 6, 0]; // Monday first
type Repeat = "daily" | "weekly" | "days";
const repeatOf = (d: number[] | null): Repeat => (!d?.length ? "daily" : d.length === 1 ? "weekly" : "days");

// The day a schedule test-restores on; matches testRestoreDay in backup.go.
function testDay(days: number[] | null) {
  if (!days?.length || days.includes(0)) return 0;
  return Math.min(...days);
}

function plural(n: number, w: string) {
  return `${n} ${w}${n === 1 ? "" : "s"}`;
}

function ago(days: number) {
  if (days < 14) return plural(Math.round(days), "day");
  if (days < 60) return plural(Math.round(days / 7), "week");
  return plural(Math.round(days / 30), "month");
}

// What a schedule's retention keeps, in a sentence.
function keepSummary(s: Schedule) {
  const runs = s.days?.length || 7; // runs per week
  const recent = Math.max(0, s.keep_daily);
  const weekly = Math.max(0, s.keep_weekly);
  const span = Math.max((recent * 7) / runs, weekly * 7);
  const what = runs === 7 ? `the backups of the last ${plural(recent, "day")}` : `the last ${plural(recent, "backup")}`;
  return (
    `For each instance this keeps ${what}` +
    (weekly ? `, and the newest backup of each of the last ${plural(weekly, "week")}` : "") +
    `. That is at most ${plural(recent + weekly, "backup")}, going back about ${ago(span)}.`
  );
}

function ScheduleCard({ s, targets, servers, dirty, set, remove, run }: { s: Schedule; targets: string[]; servers: string[]; dirty: boolean; set: (p: Partial<Schedule>) => void; remove: () => void; run: () => void }) {
  const projects = useNames(s.server, "projects");
  const [repeat, setRepeat] = useState<Repeat>(repeatOf(s.days));
  useEffect(() => setRepeat((r) => (r === "days" && s.days?.length ? r : repeatOf(s.days))), [s.days]);
  const projOpts = projects.data ? (projects.data.includes(s.project) ? projects.data : [...projects.data, s.project]) : [s.project];
  const changeRepeat = (r: Repeat) => {
    setRepeat(r);
    if (r === "daily") set({ days: [] });
    if (r === "weekly") set({ days: [s.days?.length ? testDay(s.days) : 0] });
    if (r === "days") set({ days: s.days && s.days.length > 1 ? s.days : [1, 2, 3, 4, 5] });
  };
  const toggleDay = (d: number) => {
    const cur = s.days || [];
    const next = cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d].sort();
    if (next.length) set({ days: next });
  };
  return (
    <div className="panel bk-card" style={{ marginBottom: 0 }}>
      <div className="two">
        <Field label="Name">
          <Input value={s.name} onChange={(v) => set({ name: v })} />
        </Field>
        <Field label="Target">
          <Select value={s.target} onChange={(v) => set({ target: v })} options={targets} />
        </Field>
        <Field label="Server">
          <Select value={s.server} onChange={(v) => set({ server: v, instances: [] })} options={servers.includes(s.server) ? servers : [...servers, s.server]} />
        </Field>
        <Field label="Project">
          <Select value={s.project} onChange={(v) => set({ project: v, instances: [] })} options={projOpts} />
        </Field>
        <Field label="Instances" hint="Leave none ticked to back up every instance in the project, including ones made later.">
          <InstancePick server={s.server} project={s.project} value={s.instances || []} onChange={(v) => set({ instances: v })} />
        </Field>
        <Field label="Time" hint="In the time zone of the machine that runs the UI.">
          <Input value={s.at} onChange={(v) => set({ at: v })} placeholder="03:00" />
        </Field>
      </div>
      <div className="fl">
        <label>Repeat</label>
        <div className="bk-repeat">
          <Seg<Repeat>
            label="Repeat"
            value={repeat}
            onChange={changeRepeat}
            options={[
              { v: "daily", l: "Every day" },
              { v: "weekly", l: "Once a week" },
              { v: "days", l: "Chosen days" },
            ]}
          />
          {repeat === "weekly" && (
            <div className="bk-day">
              <Select value={String(s.days?.[0] ?? 0)} onChange={(v) => set({ days: [Number(v)] })} options={WEEK.map((d) => ({ v: String(d), l: `on ${DAY_NAMES[d]}` }))} aria-label="Day of the week" />
            </div>
          )}
          {repeat === "days" && (
            <div className="bk-days" role="group" aria-label="Days of the week">
              {WEEK.map((d) => (
                <button key={d} type="button" aria-pressed={!!s.days?.includes(d)} title={DAY_NAMES[d]} onClick={() => toggleDay(d)}>
                  {DAY_NAMES[d].slice(0, 3)}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="bk-sub">
        <h3>Retention</h3>
        <p>Which of this schedule's old backups to keep. The rest are deleted after each run.</p>
      </div>
      <div className="two">
        <Field label="Recent backups to keep" hint={repeat === "daily" ? "One per day: 7 keeps the last week of daily backups." : "Counted per day with a backup: 4 keeps the last 4 runs."}>
          <Input inputMode="numeric" value={String(s.keep_daily)} onChange={(v) => set({ keep_daily: parseInt(v) || 0 })} />
        </Field>
        <Field label="Weekly backups to keep" hint="Also keeps the newest backup of each of the last weeks, for older restore points. 0 turns this off.">
          <Input inputMode="numeric" value={String(s.keep_weekly)} onChange={(v) => set({ keep_weekly: parseInt(v) || 0 })} />
        </Field>
      </div>
      <p className="none">{keepSummary(s)}</p>

      <div className="tgl-list">
        <TglRow
          title="Use the storage pool's own format"
          note="On ZFS and Btrfs pools, Incus exports a native send stream instead of copying files. It's faster and often smaller, but restores only to a pool of the same kind. Other pools make a normal backup. Each backup is still a full copy: Incus can't make incremental backup files."
          on={!!s.optimized}
          onChange={(v) => set({ optimized: v })}
        />
        <TglRow title="Test restore once a week" note={`On ${DAY_NAMES[testDay(s.days)]}s, restores that run's backups under a temporary name and deletes them again, to prove they work.`} on={s.test_restore} onChange={(v) => set({ test_restore: v })} />
        <TglRow title="Paused" on={s.paused} onChange={(v) => set({ paused: v })} />
      </div>
      <div className="card-f">
        <button className="btn btn-q btn-sm" onClick={remove}>
          Remove
        </button>
        <span className={"bk-st" + (s.state?.last_run && !s.state.last_ok && !s.state.running ? " bad" : "")}>{schedStatus(s.state)}</span>
        <span className="r">
          <button className="btn btn-s btn-sm press" disabled={dirty || s.state?.running} title={dirty ? "Save first" : undefined} onClick={run}>
            Run now
          </button>
        </span>
      </div>
    </div>
  );
}

// A checkbox dropdown of a project's instances, like the instance list's filters.
function InstancePick({ server, project, value, onChange }: { server: string; project: string; value: string[]; onChange: (v: string[]) => void }) {
  const q = useData<{ name: string; type: string }[]>(server ? `sched-insts:${server}:${project}` : null, async () =>
    ((await incus<Instance[]>(server, "/1.0/instances?recursion=1", { project })) || []).map((i) => ({ name: i.name, type: i.type })).sort((a, b) => a.name.localeCompare(b.name)),
  );
  const [open, setOpen] = useState(false);
  const { mounted, leaving } = usePresence(open);
  const ref = useRef<HTMLDivElement>(null);
  useOutside(ref, () => setOpen(false), open);
  const list = q.data || [];
  const missing = value.filter((v) => !list.some((i) => i.name === v));
  const opts = [...list.map((i) => ({ v: i.name, n: i.type === "virtual-machine" ? "VM" : "Container" })), ...missing.map((v) => ({ v, n: "Not found" }))];
  const label = value.length === 0 ? `All instances${q.data ? ` (${list.length})` : ""}` : value.length <= 2 ? value.join(", ") : `${value.length} instances`;
  return (
    <div className="fwrap bk-pick" ref={ref}>
      <button type="button" className={"field" + (open ? " open" : "")} aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="fval">{label}</span>
        {ic.down}
      </button>
      {mounted && (
        <div className={"fpop" + (leaving ? " leaving" : "")}>
          <div className="fopts">
            {q.error && <div className="fopt dis">Couldn't list the instances.</div>}
            {!q.data && !q.error && <div className="fopt dis">Loading…</div>}
            {q.data && opts.length === 0 && <div className="fopt dis">No instances in this project yet.</div>}
            {opts.map((o) => (
              <label key={o.v} className="fopt">
                <input type="checkbox" checked={value.includes(o.v)} onChange={(e) => onChange(e.target.checked ? [...value, o.v] : value.filter((x) => x !== o.v))} />
                <span className="ot">{o.v}</span>
                <span className="cnt">{o.n}</span>
              </label>
            ))}
          </div>
          <div className="ffoot">
            <button type="button" className="btn btn-q btn-sm" disabled={!value.length} onClick={() => onChange([])}>
              All instances
            </button>
            <button type="button" className="btn btn-p btn-sm press" onClick={() => setOpen(false)}>
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function schedStatus(s?: SchedState) {
  if (!s?.last_run) return "Not run yet";
  if (s.running) return "Running";
  return s.last_ok ? `Last run ${dateTime(s.last_run)}` : `Failed ${dateTime(s.last_run)}: ${s.last_error}`;
}
