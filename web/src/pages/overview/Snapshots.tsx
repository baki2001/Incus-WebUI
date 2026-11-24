import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useApp } from "../../state";
import { projectFor } from "../../data";
import { snapHealth, timeline, type Info, type TlGroup } from "./model";
import { Nothing, Skel, type D } from "./parts";

function Ring({ segs, size }: { segs: ("ok" | "none" | "bad")[]; size: number }) {
  const n = segs.length;
  const r = size / 2 - 8,
    c = size / 2,
    gap = n > 60 ? 1 : 2.2;
  const seg = 360 / n;
  const p = (a: number) => [c + r * Math.sin((a * Math.PI) / 180), c - r * Math.cos((a * Math.PI) / 180)];
  const arc = (a0: number, a1: number) => {
    const [x0, y0] = p(a0),
      [x1, y1] = p(a1);
    return `M${x0} ${y0} A${r} ${r} 0 0 1 ${x1} ${y1}`;
  };
  return (
    <svg width={size} height={size} className="sring" aria-hidden="true">
      {segs.map((k, i) =>
        n === 1 ? <circle key={i} cx={c} cy={c} r={r} className={k} /> : <path key={i} d={arc(i * seg + gap / 2, (i + 1) * seg - gap / 2)} className={k} />,
      )}
    </svg>
  );
}

export function Snapshots({ d, size }: { d: D; size: "s" | "m" }) {
  const nav = useNavigate();
  const app = useApp();
  const list = useMemo(() => (d.rows ? snapHealth(d.rows) : null), [d.rows]);
  if (!list) return <Skel lines={4} />;
  if (!list.length) return <Nothing>No instances yet.</Nothing>;
  const bad = list.filter((s) => s.bad);
  const scheduled = list.filter((s) => s.scheduled).length;
  const segs = [...list.filter((s) => s.scheduled && !s.bad), ...list.filter((s) => !s.scheduled), ...bad].map((s): "ok" | "none" | "bad" => (s.bad ? "bad" : s.scheduled ? "ok" : "none"));
  return (
    <>
      <span className="b-t">Snapshots</span>
      <div className="snap-ring">
        <Ring segs={segs} size={size === "s" ? 96 : 132} />
        <div className="ring-c" title="Instances with a snapshot schedule that is on track">
          <b>{scheduled - bad.length}</b>
          <span>of {list.length}</span>
        </div>
      </div>
      {bad.length > 0 && size === "m" ? (
        <div className="snap-list">
          {bad.slice(0, 6).map((s) => (
            <button key={s.row.server + s.row.name + s.row.project} onClick={() => nav(`/instances/${s.row.server}/${s.row.name}/snapshots?project=${encodeURIComponent(projectFor(s.row, app.project))}`)}>
              <b>{s.row.name}</b>
              <span className="snwarn">{s.label}</span>
            </button>
          ))}
          {bad.length > 6 && <small className="dim">+{bad.length - 6} more</small>}
        </div>
      ) : bad.length > 0 ? (
        <small className="snwarn">{bad.length} need a look</small>
      ) : (
        <small className="dim">{!scheduled ? "No schedules set" : scheduled === list.length ? "All on schedule" : `${scheduled} of ${list.length} instances have a schedule`}</small>
      )}
    </>
  );
}

const hh = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

export function Timeline({ d }: { d: D }) {
  const infos = Object.values(d.info || {});
  const tl = useMemo(() => (d.rows ? timeline(d.rows, d.images, infos as Info[]) : null), [d.rows, d.images, d.info]); // eslint-disable-line react-hooks/exhaustive-deps
  const now = Date.now();
  const DAY = 86400000;
  const pct = (t: number) => ((t - now) / DAY) * 100;
  const hours = useMemo(() => {
    const out: { t: number; l: string }[] = [];
    const d0 = new Date(now);
    d0.setMinutes(0, 0, 0);
    for (let t = d0.getTime() + 3600000; t < now + DAY; t += 3600000) {
      const h = new Date(t).getHours();
      const p = pct(t);
      if (h % 3 === 0 && p > 5 && p < 95) out.push({ t, l: `${String(h).padStart(2, "0")}:00` });
    }
    return out;
  }, [Math.floor(now / 600000)]); // eslint-disable-line react-hooks/exhaustive-deps
  // the dark band for 22:00 to 06:00
  const nights = useMemo(() => {
    const out: { l: number; w: number }[] = [];
    const d0 = new Date(now);
    d0.setHours(0, 0, 0, 0);
    for (let day = -1; day <= 1; day++) {
      const a = d0.getTime() + day * DAY - 2 * 3600000,
        b = a + 8 * 3600000;
      const l = Math.max(0, pct(a)),
        r = Math.min(100, pct(b));
      if (r > l) out.push({ l, w: r - l });
    }
    return out;
  }, [Math.floor(now / 600000)]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <div className="b-head">
        <span className="b-t">Next 24 hours</span>
        {tl && (
          <span className="b-r dim b-leg">
            {tl.legend.map((l) => (
              <span key={l.text}>
                {l.tick && <i className="tick-l" />}
                {l.text}
              </span>
            ))}
          </span>
        )}
      </div>
      {!tl ? (
        <Skel lines={2} />
      ) : (
        <div className="tl">
          <div className="tl-ev" style={{ height: tl.groups.length ? Math.min(4, Math.max(...tl.groups.map((g) => g.lines.length))) * 19 + 12 : 28 }}>
            {tl.groups.length === 0 && <span className="none tl-none">Nothing scheduled</span>}
            {tl.groups.map((g: TlGroup, i) => {
              const p = pct(g.at);
              return (
                <div key={i} className={"tl-e" + (p > 52 ? " flip" : "")} style={{ left: `${p}%` }}>
                  {g.lines.slice(0, 4).map((l) => (
                    <div key={l.kind} className="tl-l">
                      <span className="dim">{hh(l.at)}</span>
                      <b>{l.kind}</b>
                      <span>{l.text}</span>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
          <div className="tl-line">
            {nights.map((n, i) => (
              <i key={i} className="night" style={{ left: `${n.l}%`, width: `${n.w}%` }} />
            ))}
            {tl.ticks.map((t) => (
              <i key={t} className="tick" style={{ left: `${pct(t)}%` }} />
            ))}
            <i className="now" />
            {tl.groups.flatMap((g) => g.dots).map((t, i) => (
              <i key={i} className="dot" style={{ left: `${pct(t)}%` }} />
            ))}
          </div>
          <div className="tl-h">
            <span style={{ left: 0 }}>now</span>
            {hours.filter((h) => pct(h.t) > 8).map((h) => (
              <span key={h.t} style={{ left: `${pct(h.t)}%` }}>
                {h.l}
              </span>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
