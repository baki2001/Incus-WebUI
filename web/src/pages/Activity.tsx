import { useState } from "react";
import { Link } from "react-router-dom";
import { dateTime, incus, opProgress, since, ui } from "../api";
import { ic } from "../icons";
import { cancelJob, jobResult, useCrumbs, useJobs, type Job } from "../Shell";
import { invalidate, useApp, useData, useScopedServers } from "../state";
import { confirmDialog, Seg, Select, Table } from "../ui";
import { matches, PageHead, Search } from "./Resource";

type Op = { id: string; class: string; description: string; created_at: string; updated_at: string; status: string; status_code: number; resources: Record<string, string[]> | null; metadata: any; may_cancel: boolean; err: string; location: string; server: string; project?: string };

// Tasks: everything people did through the UI in the last 30 days, from a
// start or a delete to a backup or an import. Admins see everyone's.
export function Tasks() {
  useCrumbs([{ label: "Tasks" }]);
  const app = useApp();
  const q = useJobs(true);
  const [show, setShow] = useState<"all" | "running" | "failed">("all");
  const [search, setSearch] = useState("");
  const all = q.data;
  const rows = all?.filter((j) => (show === "all" || j.state === show) && matches(search, j.title, j.user, j.note, j.error));
  const users = new Set(all?.map((j) => j.user || ""));
  const running = all?.filter((j) => j.state === "running").length || 0;
  const failed = all?.filter((j) => j.state === "failed").length || 0;
  return (
    <>
      <PageHead title="Tasks" />
      <div className="fbar">
        <Search value={search} onChange={setSearch} placeholder="Filter by task or user" />
        <Seg
          value={show}
          onChange={setShow}
          label="Show"
          options={[
            { v: "all", l: "All" },
            { v: "running", l: <>Running<span className="n">{running}</span></> },
            { v: "failed", l: <>Failed<span className="n">{failed}</span></> },
          ]}
        />
        <span className="dim fnote">Kept for 30 days. What Incus itself runs is under Operations.</span>
      </div>
      <Table<Job>
        rows={rows}
        loading={q.loading}
        rowKey={(j) => j.id}
        empty={q.error || (all?.length ? "No tasks match." : "No tasks yet. Backups, imports and actions like starting an instance show up here.")}
        initial={{ k: "when", asc: false }}
        cols={[
          {
            k: "task",
            label: "Task",
            sort: (j) => j.title,
            cell: (j) => (
              <span className="nm">
                <span className="nm2">{j.title}</span>
                {j.link && j.state === "done" && (
                  <small>
                    <Link to={j.link} className="rlink">
                      Open result
                    </Link>
                  </small>
                )}
              </span>
            ),
          },
          {
            k: "state",
            label: "Result",
            sort: (j) => j.state,
            cell: (j) =>
              j.state === "running" ? (
                <span className="nm" style={{ display: "block" }}>
                  <span className="st busy">{Math.round(j.progress * 100)}%</span>
                  <small className="dim" style={{ display: "block" }}>{j.detail || "working"}</small>
                </span>
              ) : (
                <span className={"st" + (j.state === "failed" ? " error" : " unknown")} title={jobResult(j)}>
                  <span className="clamp2">{jobResult(j)}</span>
                </span>
              ),
          },
          { k: "user", label: "User", sort: (j) => j.user || "", cell: (j) => j.user || "Scheduler", hide: !app.admin || users.size < 2, cls: "hide-m" },
          { k: "when", label: "Started", sort: (j) => Date.parse(j.started), cell: (j) => <span className="dim" title={dateTime(j.started)}>{ago(j.started)}</span>, cls: "hide-s" },
          { k: "took", label: "Took", sort: (j) => took(j, true), cell: (j) => <span className="dim tnum">{took(j)}</span>, cls: "hide-m" },
          {
            k: "act",
            label: "",
            cell: (j) =>
              j.state === "running" ? (
                <button className="btn btn-q btn-sm" onClick={() => cancelJob(j)}>
                  Cancel
                </button>
              ) : null,
          },
        ]}
      />
    </>
  );
}

function took(j: Job, raw: true): number;
function took(j: Job): string;
function took(j: Job, raw?: boolean): number | string {
  const end = j.ended && !j.ended.startsWith("0001") ? Date.parse(j.ended) : Date.now();
  const s = Math.max(0, (end - Date.parse(j.started)) / 1000);
  if (raw) return s;
  if (s < 1) return "under 1 s";
  if (s < 60) return `${Math.round(s)} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
}

// Operations: what Incus is doing or did lately, on every server in scope.
export function Operations() {
  useCrumbs([{ label: "Operations" }]);
  const app = useApp();
  const servers = useScopedServers();
  const names = servers.map((s) => s.name).join(",");
  const multi = app.servers.length > 1;
  const q = useData<Op[]>(
    names ? `operations:${names}` : null,
    async () => {
      const all = await Promise.all(
        servers.map(async (s) => {
          const r = await incus<Record<string, Op[]>>(s.name, "/1.0/operations?recursion=1&all-projects=true").catch(() => ({}) as Record<string, Op[]>);
          return Object.values(r || {})
            .flat()
            .map((o) => ({ ...o, server: s.name }));
        }),
      );
      return all.flat().sort((a, b) => b.created_at.localeCompare(a.created_at));
    },
    3000,
  );
  const [show, setShow] = useState<"all" | "running" | "failed">("all");
  const [search, setSearch] = useState("");
  const rows = q.data?.filter((o) => (show === "all" || (show === "running" ? o.status_code < 200 : o.status_code >= 400)) && matches(search, o.description, o.class, resourceText(o, true)));
  const cancel = async (o: Op) => {
    if (!(await confirmDialog({ title: `Cancel “${o.description}”?`, body: "Incus stops it where it can.", confirm: "Cancel operation", danger: true }))) return;
    await app.run("Cancelling", () => incus(o.server, `/1.0/operations/${o.id}`, { method: "DELETE", project: o.project }), "Cancelled");
    invalidate("operations:");
  };
  const running = q.data?.filter((o) => o.status_code < 200).length || 0;
  return (
    <>
      <PageHead title="Operations" />
      <div className="fbar">
        <Search value={search} onChange={setSearch} placeholder="Filter by what it does" />
        <Seg
          value={show}
          onChange={setShow}
          label="Show"
          options={[
            { v: "all", l: "All" },
            { v: "running", l: <>Running<span className="n">{running}</span></> },
            { v: "failed", l: "Failed" },
          ]}
        />
        <span className="dim fnote">Incus keeps finished operations for a few seconds only.</span>
      </div>
      <Table<Op>
        rows={rows}
        loading={q.loading}
        rowKey={(o) => o.server + o.id}
        empty={q.error || "Nothing running right now."}
        initial={{ k: "when", asc: false }}
        cols={[
          {
            k: "desc",
            label: "Operation",
            sort: (o) => o.description,
            cell: (o) => (
              <span className="nm">
                <span className="nm2">{o.description}</span>
                <small className="dim">{resourceLinks(o)}</small>
              </span>
            ),
          },
          {
            k: "status",
            label: "State",
            sort: (o) => o.status,
            cell: (o) => (
              <span className="nm" style={{ display: "block" }}>
                <span className={"st " + (o.status_code === 200 ? "running" : o.status_code >= 400 ? "error" : "busy")}>{o.status}</span>
                {(o.err || (o.status_code < 200 && opProgress(o as any))) && <small className={o.err ? "bad" : "dim"} style={{ display: "block" }}>{o.err || opProgress(o as any)}</small>}
              </span>
            ),
          },
          { k: "server", label: "Server", sort: (o) => o.server, cell: (o) => o.server, hide: !multi, cls: "hide-m" },
          { k: "when", label: "Started", sort: (o) => o.created_at, cell: (o) => <span className="dim" title={dateTime(o.created_at)}>{ago(o.created_at)}</span>, cls: "hide-s" },
          {
            k: "act",
            label: "",
            cell: (o) =>
              o.may_cancel && o.status_code < 200 ? (
                <button className="btn btn-q btn-sm" onClick={() => cancel(o)}>
                  Cancel
                </button>
              ) : null,
          },
        ]}
      />
    </>
  );
}

const kinds: Record<string, string> = { instances: "instance", containers: "instance", virtual_machines: "instance", profiles: "profile", networks: "network", "storage-pools": "pool", images: "image", projects: "project", "storage-volumes": "volume" };

// The things an operation touches, once each ("instances" and "containers" list the same one).
function resourceItems(o: Op) {
  const seen = new Set<string>();
  const out: { kind: string; name: string; to?: string }[] = [];
  for (const [key, urls] of Object.entries(o.resources || {})) {
    for (const u of urls || []) {
      const [path, qs = ""] = u.split("?");
      const parts = path.split("/").filter(Boolean).slice(1); // drop "1.0"
      // Snapshots and backups belong to their instance.
      const name = decodeURIComponent(parts[parts[0] === "instances" || parts[0] === "containers" || parts[0] === "virtual_machines" ? 1 : parts.length - 1] || "");
      if (!name) continue;
      const kind = kinds[parts[0] || key] || parts[0] || key;
      const id = kind + "/" + name + "/" + qs;
      if (seen.has(id)) continue;
      seen.add(id);
      const project = new URLSearchParams(qs).get("project") || "default";
      const to =
        kind === "instance" ? `/instances/${o.server}/${encodeURIComponent(name)}?project=${encodeURIComponent(project)}` :
        { profile: "/profiles", network: "/networks", pool: "/storage", image: "/images", project: "/projects", volume: "/storage/volumes" }[kind];
      out.push({ kind, name, to });
    }
  }
  return out;
}

function resourceText(o: Op, name = false) {
  return resourceItems(o).map((r) => (name ? r.name : `${r.kind} ${r.name}`)).join(", ");
}

function resourceLinks(o: Op) {
  const items = resourceItems(o);
  if (!items.length) return o.class;
  return items.map((r, i) => (
    <span key={i}>
      {i > 0 && ", "}
      {r.kind}{" "}
      {r.to ? (
        <Link to={r.to} className="rlink" onClick={(e) => e.stopPropagation()}>
          {r.name}
        </Link>
      ) : (
        r.name
      )}
    </span>
  ));
}

// "3 min ago", but "just now" stands alone.
const ago = (iso: string) => {
  const t = since(iso);
  return t === "just now" || t === "–" ? t : t + " ago";
};

type Warning = { uuid: string; type: string; status: string; severity: string; count: number; first_seen_at: string; last_seen_at: string; last_message: string; project: string; entity_url: string; location: string; server: string };

export function Warnings() {
  useCrumbs([{ label: "Warnings" }]);
  const app = useApp();
  const servers = useScopedServers();
  const names = servers.map((s) => s.name).join(",");
  const multi = app.servers.length > 1;
  const q = useData<Warning[]>(names ? `warnings:${names}` : null, async () =>
    (await Promise.all(servers.map(async (s) => ((await incus<Warning[]>(s.name, "/1.0/warnings?recursion=1")) || []).map((w) => ({ ...w, server: s.name }))))).flat(),
  );
  const [show, setShow] = useState<"new" | "all">("new");
  const [search, setSearch] = useState("");
  const rows = q.data?.filter((w) => (show === "all" || w.status === "new") && matches(search, w.type, w.last_message, w.entity_url));
  const ack = async (w: Warning) => {
    await app.run("Acknowledging", () => incus(w.server, `/1.0/warnings/${w.uuid}`, { method: "PATCH", body: { status: "acknowledged" } }), "Acknowledged");
    invalidate("warnings");
  };
  const reopen = async (w: Warning) => {
    await app.run("Marking as new", () => incus(w.server, `/1.0/warnings/${w.uuid}`, { method: "PATCH", body: { status: "new" } }), "Marked as new");
    invalidate("warnings");
  };
  const del = async (w: Warning) => {
    if (!(await confirmDialog({ title: "Delete this warning?", body: `${w.type}: Incus may raise it again if the problem is still there.`, confirm: "Delete", danger: true }))) return;
    await app.run("Deleting warning", () => incus(w.server, `/1.0/warnings/${w.uuid}`, { method: "DELETE" }), "Warning deleted");
    invalidate("warnings");
  };
  const newCount = q.data?.filter((w) => w.status === "new").length || 0;
  return (
    <>
      <PageHead title="Warnings" />
      <div className="fbar">
        <Search value={search} onChange={setSearch} placeholder="Filter by type or message" />
        <Seg value={show} onChange={setShow} label="Show" options={[{ v: "new", l: <>New<span className="n">{newCount}</span></> }, { v: "all", l: <>All<span className="n">{q.data?.length || 0}</span></> }]} />
        <span className="dim fnote">Problems Incus noticed on its own, like a missing kernel feature or a failed image refresh.</span>
      </div>
      <Table<Warning>
        rows={rows}
        loading={q.loading}
        rowKey={(w) => w.server + w.uuid}
        empty={q.error || (show === "new" ? "No new warnings." : "No warnings.")}
        initial={{ k: "seen", asc: false }}
        cols={[
          {
            k: "type",
            label: "Warning",
            sort: (w) => w.type,
            cell: (w) => (
              <span className="nm wrap-cell" style={{ display: "block" }}>
                <span className="nm2">{w.type}</span>
                <small className="dim">{w.last_message}</small>
              </span>
            ),
          },
          { k: "sev", label: "Severity", sort: (w) => ["low", "moderate", "high"].indexOf(w.severity), cell: (w) => <span className={"st " + (w.severity === "high" ? "error" : w.severity === "moderate" ? "busy" : "")}>{w.severity}</span>, cls: "hide-s" },
          { k: "status", label: "Status", sort: (w) => w.status, cell: (w) => <span className={"st " + (w.status === "new" ? "busy" : "")}>{w.status === "new" ? "New" : w.status === "acknowledged" ? "Acknowledged" : w.status}</span>, hide: show !== "all", cls: "hide-s" },
          { k: "count", label: "Times", sort: (w) => w.count, cell: (w) => w.count, cls: "right hide-s" },
          { k: "seen", label: "Last seen", sort: (w) => w.last_seen_at, cell: (w) => <span className="dim" title={dateTime(w.last_seen_at)}>{ago(w.last_seen_at)}</span>, cls: "hide-m" },
          { k: "server", label: "Server", sort: (w) => w.server, cell: (w) => w.server, hide: !multi, cls: "hide-m" },
          {
            k: "act",
            label: "",
            cell: (w) => (
              <div className="qa" style={{ opacity: 1 }}>
                {w.status === "new" && (
                  <button className="btn btn-q btn-sm" onClick={() => ack(w)}>
                    Acknowledge
                  </button>
                )}
                {w.status === "acknowledged" && (
                  <button className="btn btn-q btn-sm" onClick={() => reopen(w)}>
                    Mark as new
                  </button>
                )}
                <button className="btn btn-q ib btn-sm" aria-label="Delete warning" onClick={() => del(w)}>
                  {ic.trash}
                </button>
              </div>
            ),
          },
        ]}
      />
    </>
  );
}

type AuditEntry = { time: string; user: string; method?: string; ip: string; action: string; server?: string; project?: string; status: number };

// Audit log: every change made through the UI and every sign-in. Admins only.
export function Audit() {
  useCrumbs([{ label: "Audit log" }]);
  const [month, setMonth] = useState("");
  const q = useData<{ month: string; months: string[]; entries: AuditEntry[] }>(`audit:${month}`, () => ui(`/audit${month ? `?month=${month}` : ""}`), 15000);
  const [search, setSearch] = useState("");
  const [show, setShow] = useState<"all" | "failed" | "logins">("all");
  const rows = q.data?.entries.filter(
    (e) => (show === "all" || (show === "failed" ? e.status >= 400 : e.action.startsWith("login"))) && matches(search, e.user, e.action, e.server || "", e.project || "", e.ip),
  );
  const months = q.data?.months || [];
  return (
    <>
      <PageHead title="Audit log" />
      <div className="fbar">
        <Search value={search} onChange={setSearch} placeholder="Filter by user, action or address" />
        <Seg
          value={show}
          onChange={setShow}
          label="Show"
          options={[
            { v: "all", l: "All" },
            { v: "failed", l: "Failed" },
            { v: "logins", l: "Sign-ins" },
          ]}
        />
        {months.length > 1 && <Select aria-label="Month" value={q.data?.month || ""} onChange={setMonth} options={months} />}
        <span className="dim fnote">Kept for 12 months. Request bodies are never stored.</span>
      </div>
      <Table<AuditEntry>
        rows={rows}
        loading={q.loading}
        rowKey={(e) => e.time + e.action + e.ip}
        empty={q.error || "Nothing logged this month."}
        initial={{ k: "when", asc: false }}
        cols={[
          { k: "when", label: "When", sort: (e) => e.time, cell: (e) => <span className="dim" title={dateTime(e.time)}>{ago(e.time)}</span> },
          { k: "user", label: "Who", sort: (e) => e.user, cell: (e) => <span className="nm"><span className="nm2">{e.user || "unknown"}</span><small className="dim">{e.ip}</small></span> },
          { k: "action", label: "What", sort: (e) => e.action, cell: (e) => <span className="mono">{e.action}</span> },
          { k: "where", label: "Where", sort: (e) => (e.server || "") + (e.project || ""), cell: (e) => (e.server ? `${e.server}${e.project ? " / " + e.project : ""}` : ""), cls: "hide-s" },
          { k: "status", label: "Result", sort: (e) => e.status, cell: (e) => (e.status >= 400 ? <span className="bad">{e.status}</span> : <span className="dim">{e.status}</span>) },
        ]}
      />
    </>
  );
}
