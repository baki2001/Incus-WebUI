import { useState } from "react";
import { dateTime, incus, opProgress, since } from "../api";
import { ic } from "../icons";
import { useCrumbs } from "../Shell";
import { invalidate, useApp, useData, useScopedServers } from "../state";
import { confirmDialog, Seg, Table } from "../ui";
import { matches, PageHead, Search } from "./Resource";

type Op = { id: string; class: string; description: string; created_at: string; updated_at: string; status: string; status_code: number; resources: Record<string, string[]> | null; metadata: any; may_cancel: boolean; err: string; location: string; server: string; project?: string };

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
  const rows = q.data?.filter((o) => (show === "all" || (show === "running" ? o.status_code < 200 : o.status_code >= 400)) && matches(search, o.description, o.class, resourceText(o)));
  const cancel = async (o: Op) => {
    if (!(await confirmDialog({ title: `Cancel “${o.description}”?`, body: "Incus stops it where it can.", confirm: "Cancel operation", danger: true }))) return;
    await app.run("Cancelling", () => incus(o.server, `/1.0/operations/${o.id}`, { method: "DELETE" }), "Cancelled");
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
                <small className="dim">{resourceText(o) || o.class}</small>
              </span>
            ),
          },
          {
            k: "status",
            label: "State",
            sort: (o) => o.status,
            cell: (o) => (
              <span className="nm">
                <span className={"st " + (o.status_code === 200 ? "running" : o.status_code >= 400 ? "error" : "busy")}>{o.status}</span>
                {(o.err || (o.status_code < 200 && opProgress(o as any))) && <small className={o.err ? "bad" : "dim"}>{o.err || opProgress(o as any)}</small>}
              </span>
            ),
          },
          { k: "server", label: "Server", sort: (o) => o.server, cell: (o) => o.server, hide: !multi, cls: "hide-m" },
          { k: "when", label: "Started", sort: (o) => o.created_at, cell: (o) => <span className="dim" title={dateTime(o.created_at)}>{since(o.created_at)} ago</span>, cls: "hide-s" },
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

function resourceText(o: Op) {
  return Object.values(o.resources || {})
    .flat()
    .map((u) => decodeURIComponent(u.split("?")[0].split("/").slice(2).join(" ")))
    .join(", ");
}

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
  const del = async (w: Warning) => {
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
          { k: "count", label: "Times", sort: (w) => w.count, cell: (w) => w.count, cls: "right hide-s" },
          { k: "seen", label: "Last seen", sort: (w) => w.last_seen_at, cell: (w) => <span className="dim" title={dateTime(w.last_seen_at)}>{since(w.last_seen_at)} ago</span>, cls: "hide-m" },
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
