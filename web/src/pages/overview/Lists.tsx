import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { ic } from "../../icons";
import { useApp } from "../../state";
import { projectFor, usePins, type Row } from "../../data";
import { stateAction } from "../Instances";
import { baseImages, bootOrder } from "./model";
import { Nothing, Skel, type D } from "./parts";

export function Boot({ d }: { d: D }) {
  const b = useMemo(() => (d.rows ? bootOrder(d.rows) : null), [d.rows]);
  return (
    <>
      <div className="b-head">
        <span className="b-t">Boot order</span>
        {b && b.off > 0 && <span className="b-r dim">{b.off} not set to autostart</span>}
      </div>
      {!b ? (
        <Skel lines={3} />
      ) : b.stages.length === 0 ? (
        <Nothing>No instance starts on boot. Set boot.autostart on an instance to add it here.</Nothing>
      ) : (
        <div className="stages" style={{ gridTemplateColumns: `repeat(${Math.min(b.stages.length, 3)}, minmax(0, 1fr))` }}>
          {b.stages.slice(0, 3).map((s) => (
            <div className="stage" key={s.priority}>
              <small className="dim">{s.priority ? `Priority ${s.priority}` : "No priority"}</small>
              <div className="st-n">
                {s.names.slice(0, 4).map((n) => (
                  <span key={n}>{n}</span>
                ))}
                {s.names.length > 4 && <span className="dim">+{s.names.length - 4}</span>}
              </div>
              {s.delay > 0 && <span className="st-w">wait {s.delay} s</span>}
            </div>
          ))}
        </div>
      )}
      {b && b.stages.length > 3 && <small className="dim">+{b.stages.length - 3} more stages</small>}
    </>
  );
}

// Pins that match an instance in the current scope.
export function usePinned(rows: Row[] | undefined) {
  const pins = usePins();
  const { project } = useApp();
  return useMemo(() => {
    if (!rows) return [];
    return pins.flatMap((p) => {
      const r = rows.find((x) => x.server === p.server && x.name === p.name && projectFor(x, project) === p.project);
      return r ? [r] : [];
    });
  }, [rows, pins, project]);
}

export function Pinned({ d, rows }: { d: D; rows: Row[] }) {
  const app = useApp();
  const nav = useNavigate();
  return (
    <>
      <span className="b-t">Pinned</span>
      <div className="pins">
        {rows.map((r) => {
          const on = r.status === "Running";
          const busy = !on && r.status !== "Stopped";
          return (
            <div className="pin" key={r.server + r.project + r.name}>
              <span className="st-dot" data-s={r.status} />
              <div className="pin-t">
                <b title={r.name}>{r.name}</b>
                <small className="dim">
                  {r.type === "virtual-machine" ? "VM · " : ""}
                  {r.status.toLowerCase()}
                  {app.scope === "*" && d.servers.length > 1 ? ` · ${r.server}` : ""}
                </small>
              </div>
              <div className="pin-a">
                <button className="btn btn-q ib btn-sm" aria-label={`Terminal in ${r.name}`} title="Terminal" disabled={!on} onClick={() => nav(`/instances/${r.server}/${r.name}/terminal?project=${encodeURIComponent(projectFor(r, app.project))}`)}>
                  {ic.term}
                </button>
                <button className="btn btn-q ib btn-sm" aria-label={(on ? "Stop " : "Start ") + r.name} title={on ? "Stop" : "Start"} disabled={busy} onClick={() => stateAction(app, d.rowsKey, r, on ? "stop" : "start")}>
                  {on ? ic.stop : ic.play}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

export function BaseImages({ d }: { d: D }) {
  const nav = useNavigate();
  const list = useMemo(() => (d.rows && d.images ? baseImages(d.rows, d.images) : null), [d.rows, d.images]);
  const max = Math.max(30, ...(list || []).map((i) => i.days || 0));
  return (
    <>
      <div className="b-head">
        <span className="b-t">Base images</span>
        <span className="b-r dim">days since build</span>
      </div>
      {!list ? (
        <Skel lines={3} />
      ) : list.length === 0 ? (
        <Nothing>No instance was created from an image.</Nothing>
      ) : (
        <div className="age">
          {list.slice(0, 8).map((m, i) => (
            <div className="age-r" key={i}>
              <span className="age-n" title={m.label}>
                {m.label} <span className="dim">· {m.count}</span>
              </span>
              <div className="age-t">{m.days != null && <i style={{ width: `${(m.days / max) * 100}%` }} />}</div>
              <span className="tnum">{m.days ?? "–"}</span>
              {m.newer ? (
                <button className="linkish" onClick={() => nav("/images")}>
                  Newer build
                </button>
              ) : (
                <span className="dim">{m.days == null ? "not cached" : "latest"}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
