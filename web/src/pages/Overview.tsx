import { useNavigate } from "react-router-dom";
import { bytes, incus, type ServerStatus } from "../api";
import { ic } from "../icons";
import { useCrumbs } from "../Shell";
import { useApp, useData } from "../state";
import { useInstances, type Row } from "../data";

type Res = { memTotal: number; memUsed: number; threads: number; cpuName: string; poolUsed: number; poolTotal: number; load?: number };

function useResources(s: ServerStatus) {
  return useData<Res>(
    s.online && s.trusted ? `res:${s.name}` : null,
    async () => {
      const r = await incus<any>(s.name, "/1.0/resources");
      const pools = await incus<string[]>(s.name, "/1.0/storage-pools").catch(() => [] as string[]);
      let used = 0,
        total = 0;
      await Promise.all(
        pools.map(async (p) => {
          const pr = await incus<any>(s.name, `${p}/resources`).catch(() => null);
          used += pr?.space?.used || 0;
          total += pr?.space?.total || 0;
        }),
      );
      return {
        memTotal: r.memory?.total || 0,
        memUsed: r.memory?.used || 0,
        threads: r.cpu?.total || 0,
        cpuName: r.cpu?.sockets?.[0]?.name || "",
        poolUsed: used,
        poolTotal: total,
      };
    },
    15000,
  );
}

export function Overview() {
  useCrumbs([{ label: "Overview" }]);
  const app = useApp();
  const nav = useNavigate();
  const { data: rows } = useInstances(10000);
  const servers = app.scope === "*" ? app.servers : app.servers.filter((s) => s.name === app.scope);
  return (
    <>
      <div className="ph">
        <h1>Overview</h1>
        <div className="r">
          <button className="btn btn-s press" onClick={() => nav("/settings/servers")}>
            {ic.plus}Add server
          </button>
          <button className="btn btn-p press" onClick={() => nav("/instances?create=1")}>
            {ic.plus}Create instance
          </button>
        </div>
      </div>
      <section className="panel sq">
        <div className="srow th">
          <span>Server</span>
          <span>CPU</span>
          <span>Memory</span>
          <span>Storage</span>
          <span>Instances</span>
        </div>
        <div className="srows">
          {servers.map((s) => (
            <ServerRow key={s.name} s={s} rows={(rows || []).filter((r) => r.server === s.name)} />
          ))}
        </div>
      </section>
    </>
  );
}

function Metric({ v, of, p }: { v: string; of: string; p: number | null }) {
  return (
    <div className="metric">
      <small>
        <span className="v">{v}</span>
        <span className="dim">{of}</span>
      </small>
      {p != null && (
        <div className="bar">
          <i style={{ transform: `scaleX(${Math.min(1, p)})` }} className={p > 0.9 ? "hot" : ""} />
        </div>
      )}
    </div>
  );
}

function ServerRow({ s, rows }: { s: ServerStatus; rows: Row[] }) {
  const nav = useNavigate();
  const app = useApp();
  const res = useResources(s);
  const ok = s.online && s.trusted;
  const r = res.data;
  const run = rows.filter((x) => x.status === "Running").length;
  const err = rows.filter((x) => x.status === "Error").length;
  const frozen = rows.filter((x) => x.status === "Frozen").length;
  const stopped = rows.length - run - err - frozen;
  if (!ok)
    return (
      <div className="srow off">
        <div className="sname">
          <b>
            {s.name}
            <span className="st error">{s.online ? "Not trusted" : "Unreachable"}</span>
          </b>
          <small>{s.os || s.url}</small>
        </div>
        <div className="offmsg">
          <span>{s.error}</span>
          <button className="btn btn-s btn-sm press" onClick={() => app.reloadServers()}>
            Retry
          </button>
        </div>
      </div>
    );
  return (
    <div
      className="srow"
      tabIndex={0}
      role="link"
      onClick={() => {
        app.setScope(s.name);
        nav("/instances");
      }}
      onKeyDown={(e) => e.key === "Enter" && (app.setScope(s.name), nav("/instances"))}
    >
      <div className="sname">
        <b>{s.name}</b>
        <small>
          {s.os || "–"}
          {s.version ? ` · Incus ${s.version}` : ""}
        </small>
      </div>
      {r ? (
        <>
          <Metric v={`${r.threads} threads`} of="" p={null} />
          <Metric v={bytes(r.memUsed)} of={`of ${bytes(r.memTotal, 0)}`} p={r.memTotal ? r.memUsed / r.memTotal : 0} />
          <Metric v={r.poolTotal ? bytes(r.poolUsed) : "–"} of={r.poolTotal ? `of ${bytes(r.poolTotal, 0)}` : ""} p={r.poolTotal ? r.poolUsed / r.poolTotal : null} />
        </>
      ) : (
        <>
          <span className="sk" style={{ height: 20 }} />
          <span className="sk" style={{ height: 20 }} />
          <span className="sk" style={{ height: 20 }} />
        </>
      )}
      <div className="icount">
        <b>{run}</b>
        <span className="dim">
          running{stopped ? ` · ${stopped} stopped` : ""}
        </span>
        {frozen > 0 && <span className="ist frozen">{frozen} paused</span>}
        {err > 0 && <span className="ist error">{err} error</span>}
      </div>
    </div>
  );
}
