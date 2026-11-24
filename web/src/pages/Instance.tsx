import { Fragment, useEffect, useState } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { bytes, dateTime, imageLabel, incus, incusOp, incusRaw, parseBytes, since, ui, type Instance } from "../api";
import { ic } from "../icons";
import { useCrumbs } from "../Shell";
import { invalidate, mutateCache, useApp, useData } from "../state";
import { confirmDialog, CopyBtn, Menu, Seg, Status, Tabs } from "../ui";
import { isPinned, togglePin, usePins, type Row } from "../data";
import { canDo, deleteInstance, stateAction, type Act } from "./Instances";
import { askStop, CopyDialog, FromSnapDialog, MoveDialog, nameProblem, PublishDialog, readable, RenameDialog, SnapRenameDialog } from "./InstanceDialogs";
import { ConfigTab } from "./Config";
import { FilesTab } from "./Files";
import { ConsoleTab, TerminalTab } from "./Terminal";
import { MetricsPanel } from "./Charts";
import { BackupsTab, useBackupTargets } from "./Backups";

type Tab = "overview" | "history" | "configuration" | "snapshots" | "backups" | "files" | "terminal" | "console" | "logs";
const tabOrder: Tab[] = ["overview", "history", "configuration", "snapshots", "backups", "files", "terminal", "console", "logs"];

export function InstancePage() {
  const { server = "", name = "", tab = "overview" } = useParams();
  const app = useApp();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const loc = useLocation();
  const project = params.get("project") || (app.project === "*" ? undefined : app.project);
  const key = `instance:${server}:${name}:${project || "*"}`;
  const { data: inst, error, reload } = useData<Instance & { server: string }>(
    key,
    async () => {
      let p = project;
      if (!p) {
        // "All projects": find which project the instance lives in
        const list = await incus<Instance[]>(server, "/1.0/instances?recursion=1&all-projects=true");
        p = list.find((i) => i.name === name)?.project || "default";
      }
      const i = await incus<Instance>(server, `/1.0/instances/${encodeURIComponent(name)}?recursion=1`, { project: p });
      return { ...i, server };
    },
    4000,
  );
  const [deleting, setDeleting] = useState(false);
  const [dlg, setDlg] = useState<"" | "rename" | "copy" | "move" | "publish">("");
  const [prevTab, setPrevTab] = useState<Tab>(tab as Tab);
  const [seenTerm, setSeenTerm] = useState(tab === "terminal");
  useEffect(() => {
    setSeenTerm(tab === "terminal");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server, name, project]);
  useEffect(() => {
    if (tab === "terminal") setSeenTerm(true);
  }, [tab]);
  useEffect(() => {
    if (inst) app.touch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inst]);
  useCrumbs([{ label: "Instances", to: "/instances" }, { label: name }]);
  usePins();

  if (error && !inst)
    return (
      <div className="panel" style={{ padding: 24 }}>
        <b>Can't load {name}.</b>
        <div className="dim">{error}</div>
      </div>
    );
  if (!inst)
    return (
      <div className="ihead">
        <h1>
          <span className="sk">{name}</span>
        </h1>
      </div>
    );

  const isVM = inst.type === "virtual-machine";
  const running = inst.status === "Running";
  const frozen = inst.status === "Frozen";
  const stopped = inst.status === "Stopped";
  const status = deleting ? "Deleting…" : inst.status;
  const row = inst as Row;
  const go = (t: Tab) => {
    setPrevTab(tab as Tab);
    nav(`/instances/${server}/${name}${t === "overview" ? "" : "/" + t}${loc.search}`);
  };
  const dir = tabOrder.indexOf(tab as Tab) >= tabOrder.indexOf(prevTab) ? "fromR" : "fromL";
  const act = (a: Act, force = false) => {
    mutateCache(key, (d: Instance) => ({ ...d, status: { start: "Starting", stop: "Stopping", restart: "Restarting", freeze: "Pausing", unfreeze: "Resuming" }[a] }));
    stateAction(app, null, row, a, force).then(() => reload());
  };

  return (
    <>
      <div className="ihead">
        <div style={{ minWidth: 0 }}>
          <h1>
            {inst.name} <Status status={status} />
            <PinButton pin={{ server, name, project: inst.project }} />
          </h1>
          <p>
            {isVM ? "Virtual machine" : "Container"}
            {imageLabel(inst) && (
              <>
                {" · "}
                <span className="mono">{imageLabel(inst)}</span>
              </>
            )}
            {" · "}
            {server}
            {inst.project !== "default" && ` · ${inst.project}`}
          </p>
        </div>
        <div className="r">
          {running && !deleting && tab !== "terminal" && (
            <button className="btn btn-p press" onClick={() => go("terminal")}>
              {ic.term}Terminal
            </button>
          )}
          {running ? (
            <button
              className="btn btn-s press"
              disabled={deleting}
              onClick={async () => {
                const ans = await askStop([row]);
                if (ans) act("stop", ans.force);
              }}
            >
              {ic.stop}Stop
            </button>
          ) : frozen ? (
            <>
              <button className="btn btn-p press" disabled={deleting} onClick={() => act("unfreeze")}>
                {ic.play}Resume
              </button>
              <button className="btn btn-s press" disabled={deleting} onClick={() => act("stop", true)}>
                {ic.stop}Force stop
              </button>
            </>
          ) : (
            <button className="btn btn-p press" disabled={deleting || !stopped} onClick={() => act("start")}>
              {ic.play}Start
            </button>
          )}
          <Menu
            button={(p) => (
              <button className="btn btn-s ib press" aria-label="More actions" disabled={deleting} {...p}>
                {ic.more}
              </button>
            )}
          >
            {(close) => (
              <>
                <button disabled={!canDo("restart", inst.status)} onClick={() => (close(), act("restart"))}>
                  {ic.restart}Restart
                </button>
                <button disabled={!canDo("freeze", inst.status)} onClick={() => (close(), act("freeze"))}>
                  {ic.pause}Pause
                </button>
                <button disabled={!canDo("stop", inst.status)} onClick={() => (close(), act("stop", true))}>
                  {ic.stop}Force stop
                </button>
                <button onClick={() => (close(), go("snapshots"))}>{ic.snap}Snapshots</button>
                <hr />
                {!stopped && <div className="menu-hint">Stop the instance first to rename or move it.</div>}
                <button disabled={!stopped} title={stopped ? "" : "Stop the instance first"} onClick={() => (close(), setDlg("rename"))}>
                  {ic.edit}Rename
                </button>
                <button onClick={() => (close(), setDlg("copy"))}>{ic.copy}Copy</button>
                <button disabled={!stopped} title={stopped ? "" : "Stop the instance first"} onClick={() => (close(), setDlg("move"))}>
                  {ic.right}Move
                </button>
                <button onClick={() => (close(), setDlg("publish"))}>{ic.img}Create image</button>
                <hr />
                <button className="danger" onClick={async () => (close(), (await deleteInstance(app, row, () => setDeleting(true))) ? nav("/instances") : setDeleting(false))}>
                  {ic.trash}Delete
                </button>
              </>
            )}
          </Menu>
        </div>
      </div>
      <RenameDialog key={"r" + inst.name} inst={inst} open={dlg === "rename"} onClose={() => setDlg("")} onDone={(n) => nav(`/instances/${server}/${n}${loc.search}`, { replace: true })} />
      <CopyDialog key={"c" + inst.name} inst={inst} open={dlg === "copy"} onClose={() => setDlg("")} onDone={(n, p) => nav(`/instances/${server}/${n}?project=${encodeURIComponent(p)}`)} />
      <MoveDialog key={"m" + inst.name} inst={inst} open={dlg === "move"} onClose={() => setDlg("")} onDone={(p) => nav(`/instances/${server}/${name}?project=${encodeURIComponent(p)}`, { replace: true })} />
      <PublishDialog key={"p" + inst.name} inst={inst} open={dlg === "publish"} onClose={() => setDlg("")} />
      <Tabs
        value={tab as Tab}
        onChange={go}
        tabs={[
          { v: "overview", l: "Overview" },
          { v: "history", l: "History" },
          { v: "configuration", l: "Configuration" },
          { v: "snapshots", l: "Snapshots" },
          { v: "backups", l: "Backups" },
          { v: "files", l: "File Explorer" },
          { v: "terminal", l: "Terminal" },
          { v: "console", l: "Console" },
          { v: "logs", l: "Logs" },
        ]}
      />
      <div className={"tabwrap" + (deleting ? " is-deleting" : "")}>
        <div className="tp" key={tab} style={{ ["--tp-anim" as any]: dir }}>
          {tab === "overview" && <OverviewTab inst={inst} />}
          {tab === "history" && <MetricsPanel server={server!} project={inst.project} instance={inst.name} />}
          {tab === "configuration" && <ConfigTab inst={inst} reload={reload} />}
          {tab === "snapshots" && <SnapshotsTab inst={inst} reload={reload} />}
          {tab === "backups" && <BackupsTab inst={inst} />}
          {tab === "files" && <FilesTab inst={inst} />}
          {tab === "console" && <ConsoleTab inst={inst} onStart={() => act("start")} />}
          {tab === "logs" && <LogsTab inst={inst} />}
        </div>
        {/* Stays mounted once opened so the shell survives a visit to another tab. */}
        {seenTerm && (
          <div hidden={tab !== "terminal"}>
            <TerminalTab inst={inst} onStart={() => act("start")} visible={tab === "terminal"} />
          </div>
        )}
      </div>
    </>
  );
}

// ---------- overview ----------

function useCpuPct(inst: Instance) {
  const [prev, setPrev] = useState<{ t: number; u: number } | null>(null);
  const [pct, setPct] = useState<number | null>(null);
  const u = inst.state?.cpu?.usage || 0;
  useEffect(() => {
    const now = Date.now();
    if (prev && now - prev.t > 500 && u >= prev.u) setPct(((u - prev.u) / 1e9 / ((now - prev.t) / 1000)) * 100);
    setPrev({ t: now, u });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [u]);
  return inst.status === "Running" ? pct : null;
}

function OverviewTab({ inst }: { inst: Instance & { server: string } }) {
  const nav = useNavigate();
  const cfg = inst.expanded_config || {};
  const cores = cfg["limits.cpu"];
  const cpu = useCpuPct(inst);
  const memLimit = parseBytes(cfg["limits.memory"]) || inst.state?.memory?.total || 0;
  const memUse = inst.state?.memory?.usage || 0;
  const root = inst.expanded_devices?.root;
  const rootUse = inst.state?.disk?.root?.usage;
  const rootSize = parseBytes(root?.size) || inst.state?.disk?.root?.total || 0;
  const nets = Object.entries(inst.state?.network || {}).filter(([n]) => n !== "lo");
  const snaps = (inst.snapshots || []).slice().sort((a, b) => b.created_at.localeCompare(a.created_at));
  const running = inst.status === "Running";
  return (
    <div className="col">
      <div className="panel res">
        <div>
          <label>CPU{cores ? ` · ${cores} core${cores === "1" ? "" : "s"}` : ""}</label>
          <div className="v">
            {cpu != null ? Math.round(cpu) : "–"}
            <small>%</small>
          </div>
          <div className="bar">
            <i style={{ transform: `scaleX(${cpu != null ? Math.min(1, cpu / 100 / (Number(cores) || 1)) : 0})` }} className={cpu != null && cpu / (Number(cores) || 1) > 85 ? "hot" : ""} />
          </div>
        </div>
        <div>
          <label>Memory{cfg["limits.memory"] ? ` · limit ${cfg["limits.memory"]}` : ""}</label>
          <div className="v">
            {running ? bytes(memUse).split(" ")[0] : "–"}
            <small>{running ? bytes(memUse).split(" ")[1] : ""}</small>
          </div>
          <div className="bar">
            <i style={{ transform: `scaleX(${memLimit ? Math.min(1, memUse / memLimit) : 0})` }} />
          </div>
        </div>
        <div>
          <label>Root disk{root?.pool ? ` · pool ${root.pool}` : ""}</label>
          <div className="v">
            {rootUse != null ? bytes(rootUse).split(" ")[0] : "–"}
            <small>{rootUse != null ? bytes(rootUse).split(" ")[1] + (rootSize ? ` of ${bytes(rootSize)}` : "") : ""}</small>
          </div>
          <div className="bar">
            <i style={{ transform: `scaleX(${rootSize && rootUse ? Math.min(1, rootUse / rootSize) : 0})` }} />
          </div>
        </div>
      </div>
      <div className="dgrid">
        <div className="col">
          <div className="panel">
            <div className="ptitle">
              <h2>Details</h2>
            </div>
            <dl className="kv">
              <dt>Image</dt>
              <dd className="mono">{imageLabel(inst) || "–"}</dd>
              <dt>Architecture</dt>
              <dd>{inst.architecture}</dd>
              <dt>Created</dt>
              <dd>{dateTime(inst.created_at)}</dd>
              <dt>{running ? "Started" : "Last used"}</dt>
              <dd>
                {dateTime(inst.last_used_at)}
                {running && <span className="dim"> · up {since(inst.last_used_at)}</span>}
              </dd>
              {running && (
                <>
                  <dt>Processes</dt>
                  <dd>{inst.state?.processes ?? "–"}</dd>
                </>
              )}
              <dt>Profiles</dt>
              <dd style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {inst.profiles.map((p) => (
                  <span className="tag" key={p}>
                    {p}
                  </span>
                ))}
              </dd>
              {inst.description && (
                <>
                  <dt>Description</dt>
                  <dd>{inst.description}</dd>
                </>
              )}
            </dl>
          </div>
          <div className="panel">
            <div className="ptitle">
              <h2>Network</h2>
            </div>
            {nets.length === 0 ? (
              <div className="pfoot" style={{ borderTop: 0 }}>
                {running ? "No network addresses yet." : "Addresses show up while the instance runs."}
              </div>
            ) : (
              <dl className="kv">
                {nets.map(([n, d]) => (
                  <Fragment key={n}>
                    <dt>{n}</dt>
                    <dd>
                      {d.addresses
                        .filter((a) => a.scope === "global")
                        .map((a) => (
                          <div key={a.address} className="mono">
                            {a.address}
                            <CopyBtn text={a.address} />
                          </div>
                        ))}
                      {d.hwaddr && (
                        <div className="mono dim">
                          {d.hwaddr}
                          <CopyBtn text={d.hwaddr} />
                        </div>
                      )}
                    </dd>
                  </Fragment>
                ))}
              </dl>
            )}
          </div>
        </div>
        <div className="col">
          <div className="panel">
            <div className="ptitle">
              <h2>Snapshots</h2>
              <span className="r">
                <button className="btn btn-q btn-sm" onClick={() => nav("snapshots")}>
                  All {snaps.length}
                </button>
              </span>
            </div>
            {snaps.slice(0, 3).map((s) => (
              <div className="snap" key={s.name}>
                <div>
                  <div className="mono">{s.name}</div>
                  <div className="dim" style={{ fontSize: 12.5 }}>
                    {dateTime(s.created_at)}
                  </div>
                </div>
                <span className="r mono">{s.size > 0 ? bytes(s.size) : ""}</span>
              </div>
            ))}
            <div className="pfoot">{inst.expanded_config["snapshots.schedule"] ? `Schedule: ${inst.expanded_config["snapshots.schedule"]}` : snaps.length ? "No automatic schedule" : "No snapshots yet"}</div>
          </div>
          <div className="panel">
            <div className="ptitle">
              <h2>Devices</h2>
            </div>
            <dl className="kv">
              {Object.entries(inst.expanded_devices || {}).map(([n, d]) => (
                <Fragment key={n}>
                  <dt>{n}</dt>
                  <dd>{describeDevice(d)}</dd>
                </Fragment>
              ))}
            </dl>
          </div>
        </div>
      </div>
    </div>
  );
}

function describeDevice(d: Record<string, string>) {
  switch (d.type) {
    case "disk":
      return d.path === "/" ? (
        <>
          Disk on <span className="mono">{d.pool}</span>
          {d.size ? `, ${d.size}` : ""}
        </>
      ) : (
        <span className="mono">
          {d.source || d.pool + "/" + d.source} → {d.path}
        </span>
      );
    case "nic":
      return (
        <>
          Network on <span className="mono">{d.network || d.parent}</span>
        </>
      );
    case "proxy":
      return (
        <span className="mono">
          {d.listen} → {d.connect}
        </span>
      );
    default:
      return d.type;
  }
}

// ---------- snapshots ----------

const expiries = [
  { v: "never", l: "Never expires" },
  { v: "1", l: "Expires in 1 day" },
  { v: "7", l: "Expires in 7 days" },
  { v: "30", l: "Expires in 30 days" },
  { v: "custom", l: "Custom date" },
];

function SnapshotsTab({ inst, reload }: { inst: Instance & { server: string }; reload: () => void }) {
  const app = useApp();
  const nav = useNavigate();
  const [name, setName] = useState("");
  const [stateful, setStateful] = useState(false);
  const [exp, setExp] = useState("never");
  const [custom, setCustom] = useState("");
  const [ren, setRen] = useState<string | null>(null);
  const [from, setFrom] = useState<string | null>(null);
  // Where the snapshot goes: "" is a local Incus snapshot, otherwise a backup target.
  const [where, setWhere] = useState("");
  const targets = useBackupTargets();
  const canBackup = app.can(inst.server, inst.project, "manager") && (targets.data?.length || 0) > 0;
  const dest = canBackup && targets.data!.some((t) => t.name === where) ? where : "";
  const snaps = (inst.snapshots || []).slice().sort((a, b) => b.created_at.localeCompare(a.created_at));
  const base = `/1.0/instances/${encodeURIComponent(inst.name)}`;
  const o = { project: inst.project };
  const canState = inst.status === "Running" && inst.expanded_config?.["migration.stateful"] === "true";
  const hasSize = snaps.some((s) => s.size > 0);
  const bad = nameProblem(name.trim(), dest ? [] : snaps.map((s) => s.name));
  const expiresAt = () => {
    if (exp === "never") return undefined;
    if (exp === "custom") return custom ? new Date(custom).toISOString() : undefined;
    return new Date(Date.now() + Number(exp) * 86400000).toISOString();
  };
  const create = async () => {
    if (bad || (!dest && exp === "custom" && !custom)) return;
    const n = name.trim() || `snap-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`;
    setName("");
    if (dest) {
      try {
        await ui(`/backups/${encodeURIComponent(inst.server)}`, { method: "POST", body: { project: inst.project, instance: inst.name, target: dest, name: n } });
        invalidate("ui-jobs");
        app.toast(`Saving snapshot ${n} to ${dest}. Follow it under Tasks.`);
      } catch (e) {
        app.fail(e, "Couldn't start the snapshot.");
      }
      return;
    }
    app.run(
      `Snapshot of ${inst.name}`,
      () =>
        incusOp(inst.server, base + "/snapshots", { ...o, method: "POST", body: { name: n, stateful: canState && stateful, expires_at: expiresAt() } })
          .catch((e) => {
            throw new Error(readable(e).replace("That name", `The name "${n}"`));
          })
          .then(reload),
      `Snapshot ${n} created`,
    );
  };
  const restore = async (s: string) => {
    if (!(await confirmDialog({ title: `Restore ${s}?`, body: `${inst.name} goes back to how it was at this snapshot. Changes since then are lost.`, confirm: "Restore", danger: true }))) return;
    app.run(`Restoring ${s}`, () => incusOp(inst.server, base, { ...o, method: "PUT", body: { restore: s } }).then(reload), `${inst.name} restored to ${s}`);
  };
  const del = async (s: string) => {
    if (!(await confirmDialog({ title: `Delete snapshot ${s}?`, body: "This can't be undone.", confirm: "Delete", danger: true }))) return;
    app.run(`Deleting ${s}`, () => incusOp(inst.server, `${base}/snapshots/${encodeURIComponent(s)}`, { ...o, method: "DELETE" }).then(reload), `Snapshot ${s} deleted`);
  };
  return (
    <div className="col">
      <div className="toolbar snap-bar">
        <div className="field" style={{ maxWidth: 240 }}>
          <input placeholder="Snapshot name (optional)" aria-invalid={!!bad} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} />
        </div>
        {canBackup && (
          <div className="field" style={{ maxWidth: 230 }}>
            <select aria-label="Where to keep the snapshot" value={dest} onChange={(e) => setWhere(e.target.value)}>
              <option value="">Local, on the server</option>
              {targets.data!.map((t) => (
                <option key={t.name} value={t.name}>
                  On backup target {t.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {!dest && (
          <div className="field" style={{ maxWidth: 190 }}>
            <select aria-label="Expiry" value={exp} onChange={(e) => setExp(e.target.value)}>
              {expiries.map((x) => (
                <option key={x.v} value={x.v}>
                  {x.l}
                </option>
              ))}
            </select>
          </div>
        )}
        {!dest && exp === "custom" && (
          <div className="field" style={{ maxWidth: 210 }}>
            <input type="datetime-local" aria-label="Expires on" value={custom} min={new Date().toISOString().slice(0, 16)} onChange={(e) => setCustom(e.target.value)} />
          </div>
        )}
        {canState && !dest && (
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input type="checkbox" checked={stateful} onChange={(e) => setStateful(e.target.checked)} /> Include memory
          </label>
        )}
        <button className="btn btn-s press" disabled={!!bad || (!dest && exp === "custom" && !custom)} onClick={create}>
          {ic.snap}Take snapshot
        </button>
        {bad && <span className="snap-err">{bad}</span>}
        {dest && !bad && <span className="snap-note">Saves a full copy of {inst.name} (config and root disk) to {dest}, kept until you delete it. Find it on the Backups tab or the Backups page.</span>}
      </div>
      <div className="panel tw tw-menu">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th className="hide-s">Taken</th>
              <th className="hide-s">Expires</th>
              {hasSize && <th className="right hide-s">Size</th>}
              <th />
            </tr>
          </thead>
          <tbody>
            {snaps.map((s) => (
              <tr key={s.name} style={{ cursor: "default" }}>
                <td className="mono">
                  {s.name}
                  {s.stateful && <span className="tag" style={{ marginLeft: 8 }}>with memory</span>}
                </td>
                <td className="hide-s">{dateTime(s.created_at)}</td>
                <td className="dim hide-s">{s.expires_at && !s.expires_at.startsWith("0001") ? dateTime(s.expires_at) : "Never"}</td>
                {hasSize && <td className="right mono hide-s">{s.size > 0 ? bytes(s.size) : ""}</td>}
                <td>
                  <div className="qa" style={{ opacity: 1 }}>
                    <button className="btn btn-q btn-sm" onClick={() => restore(s.name)}>
                      Restore
                    </button>
                    <Menu
                      button={(p) => (
                        <button className="btn btn-q ib btn-sm" aria-label={`More actions for ${s.name}`} {...p}>
                          {ic.more}
                        </button>
                      )}
                    >
                      {(close) => (
                        <>
                          <button onClick={() => (close(), setRen(s.name))}>{ic.edit}Rename</button>
                          <button onClick={() => (close(), setFrom(s.name))}>{ic.copy}Create instance</button>
                          <hr />
                          <button className="danger" onClick={() => (close(), del(s.name))}>
                            {ic.trash}Delete
                          </button>
                        </>
                      )}
                    </Menu>
                  </div>
                </td>
              </tr>
            ))}
            {!snaps.length && (
              <tr className="empty">
                <td colSpan={5} className="emp">
                  No snapshots yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <SnapRenameDialog key={"sr" + ren} inst={inst} snap={ren} onClose={() => setRen(null)} reload={reload} />
      <FromSnapDialog key={"sf" + from} inst={inst} snap={from} onClose={() => setFrom(null)} onDone={(n) => nav(`/instances/${inst.server}/${n}?project=${encodeURIComponent(inst.project)}`)} />
    </div>
  );
}

// ---------- logs ----------

function LogsTab({ inst }: { inst: Instance & { server: string } }) {
  const isVM = inst.type === "virtual-machine";
  const base = `/1.0/instances/${encodeURIComponent(inst.name)}`;
  const files = useData<string[]>(`logs:${inst.server}:${inst.name}`, async () => (await incus<string[]>(inst.server, base + "/logs", { project: inst.project })).map((p) => p.split("/").pop()!));
  const [which, setWhich] = useState<string>("");
  const names = files.data || [];
  const cur = which || (names.includes("lxc.log") ? "lxc.log" : names.includes("qemu.log") ? "qemu.log" : names[0] || "console");
  const [text, setText] = useState<string | null>(null);
  const load = () => {
    setText(null);
    const path = cur === "console" ? base + "/console" : `${base}/logs/${encodeURIComponent(cur)}`;
    incusRaw(inst.server, path, { project: inst.project })
      .then((r) => r.text())
      .then((t) => setText(t || "(empty)"))
      .catch((e) => setText(String(e)));
  };
  useEffect(load, [cur, inst.server, inst.name]);
  const opts = [...(isVM ? [] : ["console"]), ...names].map((n) => ({ v: n, l: n === "console" ? "Console output" : n }));
  return (
    <div className="col">
      <div className="toolbar">
        {opts.length > 0 && <Seg value={cur} onChange={setWhich} options={opts} />}
        <button className="btn btn-q btn-sm" onClick={load}>
          {ic.restart}Refresh
        </button>
      </div>
      <div className="panel">
        <pre className="code" style={{ maxHeight: "65vh" }}>
          {text ?? <span className="sk">loading log</span>}
        </pre>
        <div className="pfoot">Incus keeps these on the server. Logs from inside the instance live in its own files, see File Explorer.</div>
      </div>
    </div>
  );
}

export { invalidate };

export function PinButton({ pin }: { pin: { server: string; name: string; project: string } }) {
  const on = isPinned(pin);
  return (
    <button
      className="btn btn-q ib btn-sm pin-btn"
      aria-pressed={on}
      title={on ? "Unpin from the sidebar" : "Pin to the sidebar"}
      aria-label={on ? "Unpin from the sidebar" : "Pin to the sidebar"}
      onClick={(e) => {
        e.stopPropagation();
        togglePin(pin);
      }}
    >
      {on ? ic.starOn : ic.star}
    </button>
  );
}
