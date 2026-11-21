import { useNavigate } from "react-router-dom";
import { bytes } from "../../api";
import { useApp } from "../../state";
import { limits } from "./model";
import { Nothing, Skel, splitBytes, type D } from "./parts";

type RulerProps = { label: string; title?: string; v: string; u: string; of: string; used: number; lim?: number; note?: string; hot?: boolean };

function Ruler({ label, title, v, u, of, used, lim, note, hot }: RulerProps) {
  return (
    <div className="ruler">
      <span className="ru-l" title={title || label}>
        {label}
      </span>
      <div className="ru-b">
        <div className="ru-track">
          <i className={"ru-fill" + (hot ? " hot" : "")} style={{ width: `${Math.min(1, used) * 100}%` }} />
          {lim != null && <i className="ru-lim" style={{ left: `${Math.min(1, lim) * 100}%` }} />}
        </div>
        <div className="ru-scale">
          {[0, 25, 50, 75, 100].map((t) => (
            <span key={t} style={{ left: `${t}%` }} />
          ))}
        </div>
        {note && (
          <small className="ru-note" style={lim != null && lim <= 0.8 ? { left: `${lim * 100}%` } : { right: 0 }}>
            {note}
          </small>
        )}
      </div>
      <span className={"ru-v" + (hot ? " hot" : "")}>
        <b>{v}</b> {u} <span className="dim">{of}</span>
      </span>
    </div>
  );
}

export function Capacity({ d }: { d: D }) {
  const app = useApp();
  const nav = useNavigate();
  if (!d.servers.length) return <Nothing>No servers yet. Add one under Settings.</Nothing>;
  return (
    <>
      {d.servers.map((s, i) => {
        const ok = s.online && s.trusted;
        const rows = (d.rows || []).filter((r) => r.server === s.name);
        const run = rows.filter((r) => r.status === "Running").length;
        const err = rows.filter((r) => r.status === "Error").length;
        const paused = rows.filter((r) => r.status === "Frozen").length;
        const stopped = rows.length - run - err - paused;
        const info = d.info?.[s.name];
        const c = d.cap?.[s.name];
        const lim = c ? limits(rows, c.memTotal) : { cpu: 0, mem: 0 };
        const open = () => nav(`/hosts/${encodeURIComponent(s.name)}`);
        const ver = info?.version || s.version;
        const os = info?.os || s.os;
        const mem = splitBytes(bytes(c?.memUsed));
        return (
          <div className={"b-srv" + (i ? " more" : "")} key={s.name}>
            <div className="b-head b-link" role="link" tabIndex={0} onClick={open} onKeyDown={(e) => e.key === "Enter" && open()}>
              <span className="b-t">{s.name}</span>
              <span className="dim">{[os, ver && `Incus ${ver}`].filter(Boolean).join(" · ")}</span>
              {info?.update && <span className="b-upd">Incus {info.update} available</span>}
              <span className="b-r">
                {ok ? (
                  d.rows && (
                    <>
                      <b>{run}</b> running
                      {stopped > 0 && <span className="dim"> · {stopped} stopped</span>}
                      {paused > 0 && <span className="dim"> · {paused} paused</span>}
                      {err > 0 && <span className="ist error">{err} error</span>}
                    </>
                  )
                ) : (
                  <span className="ist error">{s.online ? "Not trusted" : "Unreachable"}</span>
                )}
              </span>
            </div>
            {!ok ? (
              <div className="b-off">
                <span className="dim">{s.error}</span>
                <button className="btn btn-s btn-sm press" onClick={() => app.reloadServers()}>
                  Retry
                </button>
              </div>
            ) : !c ? (
              <Skel lines={3} />
            ) : (
              <>
                {c.members.length > 1 && (
                  <div className="b-mem">
                    <span className="dim">{c.members.length} cluster members</span>
                    {c.members.map((m) => (
                      <span key={m.name} className={m.status === "Online" ? "" : "snwarn"}>
                        {m.name}
                        {m.status !== "Online" && ` (${m.status.toLowerCase()})`}
                      </span>
                    ))}
                  </div>
                )}
                <div className="rulers">
                  {c.threads > 0 && (
                    <Ruler
                      label="CPU"
                      v={lim.cpu > 0 ? String(lim.cpu) : String(c.threads)}
                      u={lim.cpu > 0 ? "vCPU" : "threads"}
                      of={lim.cpu > 0 ? `allocated of ${c.threads} threads` : "no limits set"}
                      used={lim.cpu / c.threads}
                      note={lim.cpu > c.threads ? "over 100 %" : undefined}
                    />
                  )}
                  {c.memTotal > 0 && (
                    <Ruler
                      label="Memory"
                      v={mem[0]}
                      u={mem[1]}
                      of={`of ${bytes(c.memTotal, 0)}`}
                      used={c.memUsed / c.memTotal}
                      lim={lim.mem > 0 ? lim.mem / c.memTotal : undefined}
                      note={lim.mem > 0 ? `limits ${bytes(lim.mem, 0)}${lim.mem > c.memTotal ? ", over 100 %" : ""}` : undefined}
                      hot={c.memUsed / c.memTotal > 0.9}
                    />
                  )}
                  {c.pools.map((p) => {
                    const u = splitBytes(bytes(p.used));
                    return (
                      <Ruler
                        key={p.names.join(",")}
                        label={p.names[0] + (p.names.length > 1 ? ` +${p.names.length - 1}` : "")}
                        title={p.names.join(", ") + (p.names.length > 1 ? " (same disk)" : "")}
                        v={u[0]}
                        u={u[1]}
                        of={`of ${bytes(p.total, 0)}`}
                        used={p.used / p.total}
                        hot={p.used / p.total > 0.9}
                      />
                    );
                  })}
                </div>
              </>
            )}
          </div>
        );
      })}
    </>
  );
}
