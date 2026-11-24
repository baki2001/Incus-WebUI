import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { bytes, imageLabel, incusOp, ipv4, since, type Instance } from "../api";
import { ic } from "../icons";
import { useCrumbs } from "../Shell";
import { invalidate, mutateCache, useApp } from "../state";
import { confirmDialog, Menu, Seg, SkRows, SortTh, Status, useOutside, usePresence } from "../ui";
import { PinButton } from "./Instance";
import { CreateInstance } from "./CreateInstance";
import { ImportSheet } from "./Import";
import { askStop } from "./InstanceDialogs";
import { isPinned, projectFor, togglePin, useInstances, usePins, type Row } from "../data";

type SortKey = "name" | "project" | "status" | "server" | "ip" | "cpu" | "mem" | "up";
export type Act = "start" | "stop" | "restart" | "freeze" | "unfreeze";

const verbs: Record<Act, [string, string]> = { start: ["Starting", "Started"], stop: ["Stopping", "Stopped"], restart: ["Restarting", "Restarted"], freeze: ["Pausing", "Paused"], unfreeze: ["Resuming", "Resumed"] };

// Which actions make sense for which state. Frozen instances can't be started
// (they resume) and can only be stopped by force.
export function canDo(a: Act, status: string) {
  switch (a) {
    case "start":
      return status === "Stopped" || status === "Error";
    case "stop":
      return status === "Running" || status === "Frozen";
    case "unfreeze":
      return status === "Frozen";
    default:
      return status === "Running";
  }
}

function why(status: string) {
  return status === "Running" ? "already running" : status === "Stopped" ? "already stopped" : status === "Frozen" ? "paused" : status.toLowerCase();
}

async function putState(r: Row, project: string, action: Act, force: boolean) {
  try {
    await incusOp(r.server, `/1.0/instances/${encodeURIComponent(r.name)}/state`, { method: "PUT", project, body: { action, timeout: 30, force: force || (action === "stop" && r.status === "Frozen") } });
  } finally {
    invalidate("instances:");
    invalidate(`instance:${r.server}:${r.name}`);
  }
}

const same = (x: Row, r: Row) => x.name === r.name && x.server === r.server && x.project === r.project;

export function stateAction(app: ReturnType<typeof useApp>, key: string | null, r: Row, action: Act, force = false) {
  const project = r.project || projectFor(r, app.project);
  // optimistic: show the transition right away
  if (key) mutateCache(key, (rows: Row[]) => rows.map((x) => (same(x, r) ? { ...x, status: verbs[action][0] } : x)));
  return app.run(`${verbs[action][0]} ${r.name}`, async () => {
    try {
      await putState(r, project, action, force);
    } finally {
      app.touch();
    }
  });
}

// Runs an action on every selected instance it applies to and says what it skipped.
async function bulkState(app: ReturnType<typeof useApp>, key: string | null, rows: Row[], action: Act, force = false) {
  const ok = rows.filter((r) => canDo(action, r.status));
  const skipped = rows.filter((r) => !canDo(action, r.status));
  if (key) mutateCache(key, (all: Row[]) => all.map((x) => (ok.some((r) => same(x, r)) ? { ...x, status: verbs[action][0] } : x)));
  const errs: string[] = [];
  let n = 0;
  await app.run(`${verbs[action][0]} ${ok.length} instance${ok.length === 1 ? "" : "s"}`, async (progress) => {
    await Promise.all(
      ok.map((r) =>
        putState(r, r.project || projectFor(r, app.project), action, force)
          .catch((e) => errs.push(`${r.name}: ${e instanceof Error ? e.message : e}`))
          .finally(() => progress(`${++n} of ${ok.length}`)),
      ),
    );
  });
  app.touch();
  const parts = [`${verbs[action][1]} ${ok.length - errs.length}`];
  if (skipped.length) {
    const g: Record<string, number> = {};
    skipped.forEach((r) => (g[why(r.status)] = (g[why(r.status)] || 0) + 1));
    const ks = Object.keys(g);
    parts.push(`skipped ${skipped.length} (${ks.length === 1 ? ks[0] : ks.map((k) => `${g[k]} ${k}`).join(", ")})`);
  }
  if (errs.length) parts.push(`${errs.length} failed: ${errs[0]}`);
  app.toast(parts.join(", "));
}

async function removeInstance(r: Row, project: string) {
  if (r.status !== "Stopped") await incusOp(r.server, `/1.0/instances/${encodeURIComponent(r.name)}/state`, { method: "PUT", project, body: { action: "stop", force: true, timeout: 30 } });
  await incusOp(r.server, `/1.0/instances/${encodeURIComponent(r.name)}`, { method: "DELETE", project });
}

// onStart fires once the person has confirmed, so a page can show "Deleting…".
export async function deleteInstance(app: ReturnType<typeof useApp>, r: Row, onStart?: () => void) {
  const ok = await confirmDialog({
    title: `Delete ${r.name}?`,
    body: "The instance, its snapshots and its root disk are removed. This can't be undone.",
    confirm: "Delete",
    danger: true,
    typeToConfirm: r.name,
  });
  if (!ok) return false;
  onStart?.();
  const done = await app.run(
    `Deleting ${r.name}`,
    async () => {
      await removeInstance(r, r.project || projectFor(r, app.project));
      invalidate("instances:");
      return true;
    },
    `${r.name} deleted`,
  );
  return !!done;
}

async function deleteMany(app: ReturnType<typeof useApp>, rows: Row[]) {
  const risky = rows.length > 1 || rows.some((r) => r.status !== "Stopped");
  const ok = await confirmDialog({
    title: rows.length === 1 ? `Delete ${rows[0].name}?` : `Delete ${rows.length} instances?`,
    body: "The instances, their snapshots and root disks are removed. Running ones are force stopped first. This can't be undone.",
    confirm: "Delete",
    danger: true,
    typeToConfirm: risky ? (rows.length === 1 ? rows[0].name : `delete ${rows.length}`) : undefined,
  });
  if (!ok) return false;
  const errs: string[] = [];
  let n = 0;
  await app.run(`Deleting ${rows.length} instance${rows.length === 1 ? "" : "s"}`, async (progress) => {
    for (const r of rows) {
      await removeInstance(r, r.project || projectFor(r, app.project)).catch((e) => errs.push(`${r.name}: ${e instanceof Error ? e.message : e}`));
      progress(`${++n} of ${rows.length}`);
    }
  });
  invalidate("instances:");
  app.touch();
  app.toast(`Deleted ${rows.length - errs.length}` + (errs.length ? `, ${errs.length} failed: ${errs[0]}` : ""));
  return true;
}

function cpuPct(r: Row, prev: Map<string, { t: number; u: number }>, id: string) {
  const u = r.state?.cpu?.usage;
  if (!u || r.status !== "Running") return null;
  const p = prev.get(id);
  const now = Date.now();
  prev.set(id, { t: now, u });
  if (!p || now - p.t < 500) return null;
  return Math.max(0, Math.min(100 * 64, ((u - p.u) / 1e9 / ((now - p.t) / 1000)) * 100));
}

const list = (v: string | null) => (v ? v.split(",").filter(Boolean) : []);

export function Instances() {
  useCrumbs([{ label: "Instances" }]);
  const app = useApp();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const { data, loading, key, at } = useInstances(5000);
  usePins();
  // Search and filters live in the URL so a link or the back button restores them.
  const patch = (u: Record<string, string | string[] | null>, replace = false) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(u)) {
      const s = Array.isArray(v) ? v.join(",") : v;
      if (!s) p.delete(k);
      else p.set(k, s);
    }
    setParams(p, { replace });
  };
  const urlQ = params.get("q") || "";
  const [q, setQ] = useState(urlQ);
  useEffect(() => setQ(urlQ), [urlQ]);
  const state = (params.get("state") as "all" | "running" | "stopped") || "all";
  const types = list(params.get("type"));
  const srvs = list(params.get("srv"));
  const projs = list(params.get("proj"));
  const profs = list(params.get("profile"));
  const sort = { k: (params.get("sort") || "name") as SortKey, asc: params.get("dir") !== "desc" };
  const [sel, setSel] = useState<Set<string>>(new Set());
  const cpuPrev = useRef(new Map<string, { t: number; u: number }>());
  const [cpu, setCpu] = useState<Record<string, number>>({});
  const search = useRef<HTMLInputElement>(null);
  const allProjects = app.project === "*";
  const id = (r: Row) => `${r.server}/${r.project}/${r.name}`;

  useEffect(() => {
    if (!data) return;
    app.touch();
    const next: Record<string, number> = {};
    for (const r of data) {
      const v = cpuPct(r, cpuPrev.current, id(r));
      if (v != null) next[id(r)] = v;
    }
    setCpu((c) => ({ ...c, ...next }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "/" && document.activeElement?.tagName !== "INPUT") {
        e.preventDefault();
        search.current?.focus();
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);

  const rows = data || [];
  const ql = urlQ.toLowerCase();
  const preds: Record<string, (r: Row) => boolean> = {
    q: (r) => !ql || r.name.toLowerCase().includes(ql) || imageLabel(r).includes(ql) || ipv4(r).includes(ql) || (r.description || "").toLowerCase().includes(ql),
    type: (r) => !types.length || types.includes(r.type),
    srv: (r) => !srvs.length || srvs.includes(r.server),
    proj: (r) => !projs.length || projs.includes(r.project),
    profile: (r) => !profs.length || r.profiles.some((p) => profs.includes(p)),
    state: (r) => state === "all" || (state === "running" ? r.status === "Running" : r.status !== "Running"),
  };
  // rows matching every filter except the named one (for the counts next to each option)
  const except = (k?: string) => rows.filter((r) => Object.entries(preds).every(([n, p]) => n === k || p(r)));
  const shown = except();
  const counts = { all: except("state").length, running: except("state").filter((r) => r.status === "Running").length };
  const val = (r: Row): string | number => {
    switch (sort.k) {
      case "status":
        return r.status;
      case "server":
        return r.server;
      case "project":
        return r.project;
      case "ip":
        return ipv4(r).split(".").map((n) => n.padStart(3, "0")).join(".");
      case "cpu":
        return cpu[id(r)] ?? -1;
      case "mem":
        return r.state?.memory?.usage ?? -1;
      case "up":
        return r.status === "Running" ? -new Date(r.last_used_at).getTime() : 1;
      default:
        return r.name;
    }
  };
  shown.sort((a, b) => {
    const x = val(a),
      y = val(b);
    const c = typeof x === "number" ? x - (y as number) : String(x).localeCompare(String(y));
    return sort.asc ? c : -c;
  });
  const multi = app.servers.length > 1;
  const selected = shown.filter((r) => sel.has(id(r)));
  const bulkPres = usePresence(selected.length > 0);
  const lastSel = useRef(0);
  if (selected.length > 0) lastSel.current = selected.length;
  const ncols = 7 + (multi ? 1 : 0) + (allProjects ? 1 : 0);

  const th = (k: SortKey, label: string, cls = "") => <SortTh k={k} label={label} cls={cls} sort={sort} setSort={(s) => patch({ sort: s.k === "name" ? null : s.k, dir: s.asc ? null : "desc" })} />;

  const chips: { label: string; clear: () => void }[] = [];
  if (urlQ) chips.push({ label: `“${urlQ}”`, clear: () => patch({ q: null }) });
  if (types.length) chips.push({ label: "Type: " + types.map((t) => (t === "container" ? "Container" : "VM")).join(", "), clear: () => patch({ type: null }) });
  if (srvs.length) chips.push({ label: "Server: " + srvs.join(", "), clear: () => patch({ srv: null }) });
  if (projs.length) chips.push({ label: "Project: " + projs.join(", "), clear: () => patch({ proj: null }) });
  if (profs.length) chips.push({ label: "Profile: " + profs.join(", "), clear: () => patch({ profile: null }) });
  if (state !== "all") chips.push({ label: state === "running" ? "Running" : "Not running", clear: () => patch({ state: null }) });

  const opts = (vals: string[], k: string, get: (r: Row, v: string) => boolean, label = (v: string) => v) => vals.map((v) => ({ v, l: label(v), n: except(k).filter((r) => get(r, v)).length }));

  // what a filter will show once applied: rows matching any picked value (a row with two profiles counts once)
  const pv = (k: string, get: (r: Row, v: string) => boolean) => (d: string[]) => except(k).filter((r) => !d.length || d.some((v) => get(r, v))).length;

  // bulk
  const n = (a: Act) => selected.filter((r) => canDo(a, r.status)).length;
  const hasFrozen = selected.some((r) => r.status === "Frozen");
  const bulk = async (a: Act) => {
    let force = false;
    if (a === "stop") {
      const ans = await askStop(selected.filter((r) => canDo("stop", r.status)));
      if (!ans) return;
      force = ans.force;
    }
    await bulkState(app, key, selected, a, force);
  };
  const rowStop = async (r: Row) => {
    const ans = await askStop([r]);
    if (ans) stateAction(app, key, r, "stop", ans.force);
  };
  const open = (r: Row, tab = "") => nav(`/instances/${r.server}/${r.name}${tab}?project=${encodeURIComponent(r.project)}`);

  return (
    <>
      <div className="ph">
        <h1>Instances</h1>
        <div className="r">
          {app.servers.some((s) => app.can(s.name, "*", "manager")) && (
            <button className="btn btn-s press" onClick={() => patch({ import: "1" })}>
              Import
            </button>
          )}
          <button className="btn btn-p press" onClick={() => patch({ create: "1" })}>
            {ic.plus}Create instance
          </button>
        </div>
      </div>
      <div className="fbar">
        <div className="field fsearch">
          {ic.search}
          <input
            ref={search}
            placeholder="Filter by name, image, IP"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              patch({ q: e.target.value }, true);
            }}
          />
          <kbd>/</kbd>
        </div>
        <Seg
          value={state}
          onChange={(v) => patch({ state: v === "all" ? null : v })}
          label="State"
          options={[
            { v: "all", l: <>All<span className="n">{counts.all}</span></> },
            { v: "running", l: <>Running<span className="n">{counts.running}</span></> },
            { v: "stopped", l: <>Not running<span className="n">{counts.all - counts.running}</span></> },
          ]}
        />
        <div className="fbtns">
          <MultiFilter label="Type" value={types} onChange={(v) => patch({ type: v })} options={opts(["container", "virtual-machine"], "type", (r, v) => r.type === v, (v) => (v === "container" ? "Container" : "Virtual machine"))} count={pv("type", (r, v) => r.type === v)} />
          {multi && <MultiFilter label="Server" value={srvs} onChange={(v) => patch({ srv: v })} options={opts([...new Set(rows.map((r) => r.server))], "srv", (r, v) => r.server === v)} count={pv("srv", (r, v) => r.server === v)} />}
          {allProjects && <MultiFilter label="Project" value={projs} onChange={(v) => patch({ proj: v })} options={opts([...new Set(rows.map((r) => r.project))].sort(), "proj", (r, v) => r.project === v)} count={pv("proj", (r, v) => r.project === v)} />}
          <MultiFilter label="Profile" value={profs} onChange={(v) => patch({ profile: v })} options={opts([...new Set(rows.flatMap((r) => r.profiles))].sort(), "profile", (r, v) => r.profiles.includes(v))} count={pv("profile", (r, v) => r.profiles.includes(v))} />
        </div>
      </div>
      {chips.length > 0 && (
        <div className="applied">
          <span className="rc">
            <b>{shown.length}</b> of {rows.length}
          </span>
          {chips.map((c) => (
            <span className="chip" key={c.label}>
              <span className="chip-b">{c.label}</span>
              <button className="chip-x" aria-label={"Remove " + c.label} onClick={c.clear}>
                {ic.x}
              </button>
            </span>
          ))}
          <button className="btn btn-q btn-sm" onClick={() => patch({ q: null, type: null, srv: null, proj: null, profile: null, state: null })}>
            Clear all
          </button>
        </div>
      )}
      <div className="panel tw inst-tw">
        <table>
          <thead>
            <tr>
              <th className="chk">
                <label className="chk-l">
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    checked={shown.length > 0 && selected.length === shown.length}
                    onChange={(e) => setSel(e.target.checked ? new Set(shown.map(id)) : new Set())}
                  />
                </label>
              </th>
              {th("name", "Name")}
              {allProjects && th("project", "Project", "hide-s")}
              {th("status", "State")}
              {multi && th("server", "Server", "hide-m")}
              {th("ip", "IPv4", "hide-s")}
              {th("cpu", "CPU", "right hide-m")}
              {th("mem", "Memory", "right hide-m")}
              {th("up", "Uptime", "hide-m")}
              <th />
            </tr>
          </thead>
          <tbody>
            {!data && loading && <SkRows cols={ncols + 2} />}
            {shown.map((r) => {
              const c = cpu[id(r)];
              const frozen = r.status === "Frozen";
              const pin = { server: r.server, name: r.name, project: r.project };
              return (
                <tr key={id(r)} className={sel.has(id(r)) ? "sel" : ""} onClick={() => open(r)}>
                  <td className="chk" onClick={(e) => e.stopPropagation()}>
                    <label className="chk-l">
                      <input
                        type="checkbox"
                        aria-label={"Select " + r.name}
                        checked={sel.has(id(r))}
                        onChange={(e) => {
                          const s = new Set(sel);
                          e.target.checked ? s.add(id(r)) : s.delete(id(r));
                          setSel(s);
                        }}
                      />
                    </label>
                  </td>
                  <td className="nm">
                    <b>{r.name}</b>
                    <small className="mono">
                      {r.type === "virtual-machine" ? "VM · " : ""}
                      {imageLabel(r) || "–"}
                      {allProjects && r.project !== "default" && <span className="show-s-only"> · {r.project}</span>}
                    </small>
                  </td>
                  {allProjects && <td className="hide-s">{r.project}</td>}
                  <td>
                    <Status status={r.status} />
                  </td>
                  {multi && <td className="hide-m">{r.server}</td>}
                  <td className="mono hide-s">{ipv4(r) || <span className="dim">–</span>}</td>
                  <td className="right mono hide-m">{r.status === "Running" && c != null ? `${Math.round(c)}%` : <span className="dim">–</span>}</td>
                  <td className="right mono hide-m">{r.status === "Running" ? bytes(r.state?.memory?.usage) : <span className="dim">–</span>}</td>
                  <td className="dim hide-m">{r.status === "Running" ? since(r.last_used_at) : "–"}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <div className="qa qa-inline">
                      <PinButton pin={pin} />
                      {r.status === "Running" && (
                        <button className="btn btn-q ib btn-sm" title="Terminal" aria-label="Terminal" onClick={() => open(r, "/terminal")}>
                          {ic.term}
                        </button>
                      )}
                      {frozen && (
                        <button className="btn btn-q ib btn-sm" title="Resume" aria-label="Resume" onClick={() => stateAction(app, key, r, "unfreeze")}>
                          {ic.play}
                        </button>
                      )}
                      {r.status === "Stopped" && (
                        <button className="btn btn-q ib btn-sm" title="Start" aria-label="Start" onClick={() => stateAction(app, key, r, "start")}>
                          {ic.play}
                        </button>
                      )}
                      {canDo("stop", r.status) && (
                        <button className="btn btn-q ib btn-sm qa-stop" title="Stop" aria-label="Stop" onClick={() => rowStop(r)}>
                          {ic.stop}
                        </button>
                      )}
                    </div>
                    <div className="qa qa-more-w">
                      <Menu
                        button={(p) => (
                          <button className="btn btn-q ib qa-more" aria-label="More actions" {...p}>
                            {ic.more}
                          </button>
                        )}
                      >
                        {(close) => (
                          <>
                            <button onClick={() => (close(), togglePin(pin))}>
                              {isPinned(pin) ? ic.starOn : ic.star}
                              {isPinned(pin) ? "Unpin" : "Pin to sidebar"}
                            </button>
                            {r.status === "Running" && <button onClick={() => (close(), open(r, "/terminal"))}>{ic.term}Terminal</button>}
                            {frozen && <button onClick={() => (close(), stateAction(app, key, r, "unfreeze"))}>{ic.play}Resume</button>}
                            {r.status === "Stopped" && <button onClick={() => (close(), stateAction(app, key, r, "start"))}>{ic.play}Start</button>}
                            {canDo("stop", r.status) && <button onClick={() => (close(), rowStop(r))}>{ic.stop}Stop</button>}
                          </>
                        )}
                      </Menu>
                    </div>
                  </td>
                </tr>
              );
            })}
            {data && shown.length === 0 && (
              <tr className="empty">
                <td colSpan={ncols + 2} className="emp">
                  {rows.length ? "No instances match these filters." : "No instances yet."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {bulkPres.mounted && (
        <div className={"bulk" + (bulkPres.leaving ? " leaving" : "")}>
          <b>{selected.length || lastSel.current} selected</b>
          <button className="btn btn-q btn-sm press" disabled={!n("start")} onClick={() => bulk("start")}>
            {ic.play}Start
          </button>
          {hasFrozen && (
            <button className="btn btn-q btn-sm press" disabled={!n("unfreeze")} onClick={() => bulk("unfreeze")}>
              {ic.play}Resume
            </button>
          )}
          <button className="btn btn-q btn-sm press" disabled={!n("stop")} onClick={() => bulk("stop")}>
            {ic.stop}Stop
          </button>
          <button className="btn btn-q btn-sm press" disabled={!n("restart")} onClick={() => bulk("restart")}>
            {ic.restart}Restart
          </button>
          <button className="btn btn-q btn-sm press" disabled={!n("freeze")} onClick={() => bulk("freeze")}>
            Pause
          </button>
          <button className="btn btn-q btn-sm press" onClick={async () => (await deleteMany(app, selected)) && setSel(new Set())}>
            {ic.trash}Delete
          </button>
          <span className="vsep" />
          <button className="btn btn-q ib btn-sm" aria-label="Clear selection" onClick={() => setSel(new Set())}>
            {ic.x}
          </button>
        </div>
      )}
      <ImportSheet open={params.get("import") === "1"} onClose={() => patch({ import: null })} />
      <CreateInstance
        open={params.get("create") === "1"}
        onClose={() => patch({ create: null })}
        preset={{ image: params.get("image") || undefined, server: params.get("server") || undefined, iso: params.get("iso") || undefined }}
      />
    </>
  );
}

function MultiFilter({ label, value, onChange, options, count }: { label: string; value: string[]; onChange: (v: string[]) => void; options: { v: string; l: string; n: number }[]; count: (d: string[]) => number }) {
  const [open, setOpen] = useState(false);
  const { mounted, leaving } = usePresence(open);
  const [draft, setDraft] = useState<string[]>(value);
  const ref = useRef<HTMLDivElement>(null);
  useOutside(ref, () => setOpen(false), open);
  const on = value.length > 0;
  const preview = count(draft);
  return (
    <div className="fwrap" ref={ref}>
      <button className={"fbtn" + (on ? " on" : "")} aria-expanded={open} onClick={() => (setDraft(value), setOpen(!open))}>
        {on ? <b>{label}</b> : label}
        {on && <span className="fval">{value.length === 1 ? options.find((o) => o.v === value[0])?.l : `${value.length} selected`}</span>}
        {ic.down}
      </button>
      {mounted && (
        <div className={"fpop" + (leaving ? " leaving" : "")}>
          <div className="fopts">
            {options.map((o) => (
              <label key={o.v} className={"fopt" + (o.n === 0 && !draft.includes(o.v) ? " dis" : "")}>
                <input
                  type="checkbox"
                  disabled={o.n === 0 && !draft.includes(o.v)}
                  checked={draft.includes(o.v)}
                  onChange={(e) => setDraft(e.target.checked ? [...draft, o.v] : draft.filter((x) => x !== o.v))}
                />
                <span className="ot">{o.l}</span>
                <span className="cnt">{o.n}</span>
              </label>
            ))}
          </div>
          <div className="ffoot">
            <button className="btn btn-q btn-sm" onClick={() => setDraft([])}>
              Clear
            </button>
            <button className="btn btn-p btn-sm press" onClick={() => (onChange(draft), setOpen(false))}>
              Show {preview}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export type { Instance };
