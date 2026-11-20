import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { bytes, imageLabel, incusOp, ipv4, since, type Instance } from "../api";
import { ic } from "../icons";
import { useCrumbs } from "../Shell";
import { invalidate, mutateCache, useApp } from "../state";
import { confirmDialog, Seg, SkRows, SortTh, Status, useOutside } from "../ui";
import { PinButton } from "./Instance";
import { CreateInstance } from "./CreateInstance";
import { projectFor, useInstances, usePins, type Row } from "../data";

type SortKey = "name" | "status" | "server" | "ip" | "cpu" | "mem" | "up";

export function stateAction(app: ReturnType<typeof useApp>, key: string | null, r: Row, action: "start" | "stop" | "restart" | "freeze" | "unfreeze", force = false) {
  const project = projectFor(r, app.project);
  const verb = { start: "Starting", stop: "Stopping", restart: "Restarting", freeze: "Pausing", unfreeze: "Resuming" }[action];
  // optimistic: show the transition right away
  if (key) mutateCache(key, (rows: Row[]) => rows.map((x) => (x.name === r.name && x.server === r.server ? { ...x, status: verb } : x)));
  return app.run(`${verb} ${r.name}`, async () => {
    try {
      await incusOp(r.server, `/1.0/instances/${encodeURIComponent(r.name)}/state`, { method: "PUT", project, body: { action, timeout: 30, force } });
    } finally {
      invalidate("instances:");
      invalidate(`instance:${r.server}:${r.name}`);
      app.touch();
    }
  });
}

export async function deleteInstance(app: ReturnType<typeof useApp>, r: Row) {
  const ok = await confirmDialog({
    title: `Delete ${r.name}?`,
    body: "The instance, its snapshots and its root disk are removed. This can't be undone.",
    confirm: "Delete",
    danger: true,
    typeToConfirm: r.name,
  });
  if (!ok) return false;
  const project = projectFor(r, app.project);
  await app.run(
    `Deleting ${r.name}`,
    async () => {
      if (r.status !== "Stopped") await incusOp(r.server, `/1.0/instances/${encodeURIComponent(r.name)}/state`, { method: "PUT", project, body: { action: "stop", force: true, timeout: 30 } });
      await incusOp(r.server, `/1.0/instances/${encodeURIComponent(r.name)}`, { method: "DELETE", project });
      invalidate("instances:");
    },
    `${r.name} deleted`,
  );
  return true;
}

function cpuPct(r: Row, prev: Map<string, { t: number; u: number }>) {
  const u = r.state?.cpu?.usage;
  if (!u || r.status !== "Running") return null;
  const id = r.server + "/" + r.name;
  const p = prev.get(id);
  const now = Date.now();
  prev.set(id, { t: now, u });
  if (!p || now - p.t < 500) return null;
  return Math.max(0, Math.min(100 * 64, ((u - p.u) / 1e9 / ((now - p.t) / 1000)) * 100));
}

export function Instances() {
  useCrumbs([{ label: "Instances" }]);
  const app = useApp();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const { data, loading, key, at } = useInstances(5000);
  usePins();
  const [q, setQ] = useState("");
  const [state, setState] = useState<"all" | "running" | "stopped">("all");
  const [types, setTypes] = useState<string[]>([]);
  const [srvs, setSrvs] = useState<string[]>([]);
  const [sort, setSort] = useState<{ k: SortKey; asc: boolean }>({ k: "name", asc: true });
  const [sel, setSel] = useState<Set<string>>(new Set());
  const cpuPrev = useRef(new Map<string, { t: number; u: number }>());
  const [cpu, setCpu] = useState<Record<string, number>>({});
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!data) return;
    app.touch();
    const next: Record<string, number> = {};
    for (const r of data) {
      const v = cpuPct(r, cpuPrev.current);
      if (v != null) next[r.server + "/" + r.name] = v;
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
  const ql = q.toLowerCase();
  const base = rows.filter((r) => !ql || r.name.toLowerCase().includes(ql) || imageLabel(r).includes(ql) || ipv4(r).includes(ql) || (r.description || "").toLowerCase().includes(ql));
  const byType = (r: Row) => !types.length || types.includes(r.type);
  const bySrv = (r: Row) => !srvs.length || srvs.includes(r.server);
  const byState = (r: Row) => state === "all" || (state === "running" ? r.status === "Running" : r.status !== "Running");
  const shown = base.filter((r) => byType(r) && bySrv(r) && byState(r));
  const counts = {
    all: base.filter((r) => byType(r) && bySrv(r)).length,
    running: base.filter((r) => byType(r) && bySrv(r) && r.status === "Running").length,
  };
  const val = (r: Row): string | number => {
    switch (sort.k) {
      case "status":
        return r.status;
      case "server":
        return r.server;
      case "ip":
        return ipv4(r).split(".").map((n) => n.padStart(3, "0")).join(".");
      case "cpu":
        return cpu[r.server + "/" + r.name] ?? -1;
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
  const id = (r: Row) => r.server + "/" + r.name;
  const selected = shown.filter((r) => sel.has(id(r)));

  const th = (k: SortKey, label: string, cls = "") => <SortTh k={k} label={label} cls={cls} sort={sort} setSort={(s) => setSort(s as { k: SortKey; asc: boolean })} />;

  const chips: { label: string; clear: () => void }[] = [];
  if (q) chips.push({ label: `“${q}”`, clear: () => setQ("") });
  if (types.length) chips.push({ label: "Type: " + types.map((t) => (t === "container" ? "Container" : "VM")).join(", "), clear: () => setTypes([]) });
  if (srvs.length) chips.push({ label: "Server: " + srvs.join(", "), clear: () => setSrvs([]) });
  if (state !== "all") chips.push({ label: state === "running" ? "Running" : "Not running", clear: () => setState("all") });

  return (
    <>
      <div className="ph">
        <h1>Instances</h1>
        <div className="r">
          <button className="btn btn-p press" onClick={() => setParams({ create: "1" })}>
            {ic.plus}Create instance
          </button>
        </div>
      </div>
      <div className="fbar">
        <div className="field fsearch">
          {ic.search}
          <input ref={search} placeholder="Filter by name, image, IP" value={q} onChange={(e) => setQ(e.target.value)} />
          <kbd>/</kbd>
        </div>
        <Seg
          value={state}
          onChange={setState}
          label="State"
          options={[
            { v: "all", l: <>All<span className="n">{counts.all}</span></> },
            { v: "running", l: <>Running<span className="n">{counts.running}</span></> },
            { v: "stopped", l: <>Not running<span className="n">{counts.all - counts.running}</span></> },
          ]}
        />
        <div className="fbtns">
          <MultiFilter
            label="Type"
            value={types}
            onChange={setTypes}
            options={[
              { v: "container", l: "Container", n: base.filter((r) => bySrv(r) && byState(r) && r.type === "container").length },
              { v: "virtual-machine", l: "Virtual machine", n: base.filter((r) => bySrv(r) && byState(r) && r.type === "virtual-machine").length },
            ]}
          />
          {multi && (
            <MultiFilter
              label="Server"
              value={srvs}
              onChange={setSrvs}
              options={[...new Set(rows.map((r) => r.server))].map((s) => ({ v: s, l: s, n: base.filter((r) => byType(r) && byState(r) && r.server === s).length }))}
            />
          )}
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
          <button className="btn btn-q btn-sm" onClick={() => (setQ(""), setTypes([]), setSrvs([]), setState("all"))}>
            Clear all
          </button>
        </div>
      )}
      <div className="panel tw">
        <table>
          <thead>
            <tr>
              <th className="chk">
                <input
                  type="checkbox"
                  aria-label="Select all"
                  checked={shown.length > 0 && selected.length === shown.length}
                  onChange={(e) => setSel(e.target.checked ? new Set(shown.map(id)) : new Set())}
                />
              </th>
              {th("name", "Name")}
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
            {!data && loading && <SkRows cols={multi ? 9 : 8} />}
            {shown.map((r) => {
              const c = cpu[id(r)];
              return (
                <tr key={id(r)} className={sel.has(id(r)) ? "sel" : ""} onClick={() => nav(`/instances/${r.server}/${r.name}?project=${encodeURIComponent(r.project)}`)}>
                  <td className="chk" onClick={(e) => e.stopPropagation()}>
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
                  </td>
                  <td className="nm">
                    <b>{r.name}</b>
                    <small className="mono">
                      {r.type === "virtual-machine" ? "VM · " : ""}
                      {imageLabel(r) || "–"}
                      {app.project === "*" && r.project !== "default" ? ` · ${r.project}` : ""}
                    </small>
                  </td>
                  <td>
                    <Status status={r.status} />
                  </td>
                  {multi && <td className="hide-m">{r.server}</td>}
                  <td className="mono hide-s">{ipv4(r) || <span className="dim">–</span>}</td>
                  <td className="right mono hide-m">{r.status === "Running" && c != null ? `${Math.round(c)}%` : <span className="dim">–</span>}</td>
                  <td className="right mono hide-m">{r.status === "Running" ? bytes(r.state?.memory?.usage) : <span className="dim">–</span>}</td>
                  <td className="dim hide-m">{r.status === "Running" ? since(r.last_used_at) : "–"}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <div className="qa">
                      <PinButton pin={{ server: r.server, name: r.name, project: r.project }} />
                      {r.status === "Running" ? (
                        <>
                          <button className="btn btn-q ib btn-sm" title="Terminal" aria-label="Terminal" onClick={() => nav(`/instances/${r.server}/${r.name}/terminal?project=${encodeURIComponent(r.project)}`)}>
                            {ic.term}
                          </button>
                          <button className="btn btn-q ib btn-sm" title="Stop" aria-label="Stop" onClick={() => stateAction(app, key, r, "stop")}>
                            {ic.stop}
                          </button>
                        </>
                      ) : (
                        <button className="btn btn-q ib btn-sm" title="Start" aria-label="Start" onClick={() => stateAction(app, key, r, "start")}>
                          {ic.play}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {data && shown.length === 0 && (
              <tr style={{ cursor: "default" }}>
                <td colSpan={9} className="dim" style={{ padding: 24, textAlign: "center" }}>
                  {rows.length ? "No instances match these filters." : "No instances yet."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {selected.length > 0 && (
        <div className="bulk">
          <b>{selected.length} selected</b>
          <button className="btn btn-q btn-sm press" onClick={() => selected.forEach((r) => r.status !== "Running" && stateAction(app, key, r, "start"))}>
            {ic.play}Start
          </button>
          <button className="btn btn-q btn-sm press" onClick={() => selected.forEach((r) => r.status === "Running" && stateAction(app, key, r, "stop"))}>
            {ic.stop}Stop
          </button>
          <button className="btn btn-q btn-sm press" onClick={() => selected.forEach((r) => r.status === "Running" && stateAction(app, key, r, "restart"))}>
            {ic.restart}Restart
          </button>
          <span className="vsep" />
          <button className="btn btn-q ib btn-sm" aria-label="Clear selection" onClick={() => setSel(new Set())}>
            {ic.x}
          </button>
        </div>
      )}
      <CreateInstance
        open={params.get("create") === "1"}
        onClose={() => setParams({})}
        preset={{ image: params.get("image") || undefined, server: params.get("server") || undefined, iso: params.get("iso") || undefined }}
      />
    </>
  );
}

function MultiFilter({ label, value, onChange, options }: { label: string; value: string[]; onChange: (v: string[]) => void; options: { v: string; l: string; n: number }[] }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>(value);
  const ref = useRef<HTMLDivElement>(null);
  useOutside(ref, () => setOpen(false), open);
  const on = value.length > 0;
  const preview = options.filter((o) => !draft.length || draft.includes(o.v)).reduce((a, o) => a + o.n, 0);
  return (
    <div className="fwrap" ref={ref}>
      <button className={"fbtn" + (on ? " on" : "")} aria-expanded={open} onClick={() => (setDraft(value), setOpen(!open))}>
        {on ? <b>{label}</b> : label}
        {on && <span className="fval">{value.length === 1 ? options.find((o) => o.v === value[0])?.l : `${value.length} selected`}</span>}
        {ic.down}
      </button>
      {open && (
        <div className="fpop">
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
