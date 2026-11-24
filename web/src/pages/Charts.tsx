import { useEffect, useId, useRef, useState } from "react";
import { bytes, ui } from "../api";
import { useData } from "../state";
import { Seg } from "../ui";

type Range = "1h" | "24h" | "7d";
type Metrics = { start: number; step: number; range: Range; instances: number; series: Record<"cpu" | "mem" | "rx" | "tx" | "rd" | "wr", (number | null)[]> };

const rate = (n: number) => bytes(n) + "/s";
const cores = (n: number) => (n < 0.1 ? `${Math.round(n * 1000) / 10}% of a core` : `${Math.round(n * 100) / 100} cores`);
const coresAxis = (n: number) => {
  if (n === 0) return "0";
  if (n < 1) {
    const pct = Math.round(n * 1000) / 10;
    return `${pct}%`;
  }
  const c = Math.round(n * 10) / 10;
  return `${c}c`;
};

function niceDecimal(maxVal: number, floor: number) {
  const v = Math.max(maxVal * 1.15, floor);
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  const m = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return m * exp;
}

function niceBytes(maxVal: number, floor: number) {
  const v = Math.max(maxVal * 1.15, floor);
  let unit = 1;
  while (v / unit >= 1024 && unit < 1024 ** 4) unit *= 1024;
  const f = v / unit;
  const steps = [1, 2, 4, 5, 8, 10, 16, 20, 25, 32, 40, 50, 64, 80, 100, 128, 200, 256, 512, 1024];
  const m = steps.find((s) => s >= f) || 1024;
  return m * unit;
}

function compactBytes(n: number) {
  if (n === 0) return "0";
  const u = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  const s = v >= 10 || Number.isInteger(v) ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, "");
  return `${s} ${u[i]}`;
}

// History charts for one instance, or for every instance on a server you may see.
export function MetricsPanel({ server, project, instance }: { server: string; project?: string; instance?: string }) {
  const [range, setRange] = useState<Range>("1h");
  const qs = new URLSearchParams({ range });
  if (instance) {
    qs.set("instance", instance);
    qs.set("project", project || "default");
  }
  const q = useData<Metrics>(`metrics:${server}:${project}:${instance}:${range}`, () => ui(`/metrics/${encodeURIComponent(server)}?${qs}`), 60000);
  const m = q.data;
  const has = (k: keyof Metrics["series"]) => !!m?.series[k]?.some((v) => v != null && v > 0);
  return (
    <div className="panel">
      <div className="ptitle">
        <h2>{instance ? "History" : "History of all instances"}</h2>
        <span className="r">
          <Seg value={range} onChange={setRange} label="Range" options={[{ v: "1h", l: "1 hour" }, { v: "24h", l: "24 hours" }, { v: "7d", l: "7 days" }]} />
        </span>
      </div>
      <div className="charts">
        {q.error && <div className="note-box bad">{String(q.error)}</div>}
        {m && m.instances === 0 && <p className="none">No history yet. The UI records a point every minute from now on.</p>}
        {m && m.instances > 0 && (
          <div className="charts-g">
            <Chart title="CPU" m={m} a="cpu" fmt={cores} fmtAxis={coresAxis} ceil={(v) => niceDecimal(v, 0.01)} />
            <Chart title="Memory" m={m} a="mem" fmt={(n) => bytes(n)} fmtAxis={compactBytes} ceil={(v) => niceBytes(v, 16 * 1024 * 1024)} />
            <Chart title="Network" m={m} a="rx" b="tx" la="in" lb="out" fmt={rate} fmtAxis={(n) => (n === 0 ? "0" : compactBytes(n) + "/s")} ceil={(v) => niceBytes(v, 1024)} />
            {(has("rd") || has("wr")) && <Chart title="Disk" m={m} a="rd" b="wr" la="read" lb="write" fmt={rate} fmtAxis={(n) => (n === 0 ? "0" : compactBytes(n) + "/s")} ceil={(v) => niceBytes(v, 1024)} />}
          </div>
        )}
      </div>
    </div>
  );
}

const H = 112;
const PAD_T = 6;
const PAD_B = 6;
const PLOT_H = H - PAD_T - PAD_B;

type SegData = { line: string; area: string; singles: { x: number; y: number }[] };

function buildSeries(s: (number | null)[], x: (i: number) => number, y: (v: number) => number): SegData {
  let line = "";
  let area = "";
  const singles: { x: number; y: number }[] = [];
  const baseY = (PAD_T + PLOT_H).toFixed(1);
  let i = 0;
  while (i < s.length) {
    if (s[i] == null) {
      i++;
      continue;
    }
    const start = i;
    while (i < s.length && s[i] != null) i++;
    const end = i - 1;
    if (start === end) {
      singles.push({ x: x(start), y: y(s[start]!) });
      continue;
    }
    let seg = `M${x(start).toFixed(1)} ${y(s[start]!).toFixed(1)}`;
    for (let k = start + 1; k <= end; k++) seg += ` L${x(k).toFixed(1)} ${y(s[k]!).toFixed(1)}`;
    line += (line ? " " : "") + seg;
    area += (area ? " " : "") + `${seg} L${x(end).toFixed(1)} ${baseY} L${x(start).toFixed(1)} ${baseY} Z`;
  }
  return { line, area, singles };
}

function Chart({
  title,
  m,
  a,
  b,
  la,
  lb,
  fmt,
  fmtAxis,
  ceil,
}: {
  title: string;
  m: Metrics;
  a: keyof Metrics["series"];
  b?: keyof Metrics["series"];
  la?: string;
  lb?: string;
  fmt: (n: number) => string;
  fmtAxis: (n: number) => string;
  ceil: (maxVal: number) => number;
}) {
  const gradId = useId();
  const plotRef = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(320);
  useEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    const sync = () => {
      const next = Math.max(120, Math.round(el.clientWidth));
      setW((prev) => (prev === next ? prev : next));
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const sa = m.series[a] || [];
  const sb = b ? m.series[b] || [] : [];
  const n = Math.max(sa.length, sb.length);
  const rawMax = Math.max(0, ...sa.map((v) => v ?? 0), ...sb.map((v) => v ?? 0));
  const top = ceil(rawMax);
  const x = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * w);
  const y = (v: number) => PAD_T + PLOT_H - Math.min(1, Math.max(0, v / top)) * PLOT_H;

  const pa = buildSeries(sa, x, y);
  const pb = b ? buildSeries(sb, x, y) : null;

  const [hover, setHover] = useState<number | null>(null);
  const at = hover ?? lastIndex(sa, sb);
  const time = (i: number) => new Date((m.start + i * m.step) * 1000);
  const label = (i: number) => {
    const t = time(i);
    return m.range === "7d" ? t.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" }) : t.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  };
  const midIdx = n > 2 ? Math.floor((n - 1) / 2) : -1;
  const hvA = hover != null && sa[hover] != null ? sa[hover]! : null;
  const hvB = hover != null && b && sb[hover] != null ? sb[hover]! : null;

  return (
    <figure className="chart">
      <figcaption>
        <span className="ct">{title}</span>
        <span className="cv">
          <span className="cs">
            {b && <i className="csw a" aria-hidden="true" />}
            {at >= 0 && sa[at] != null ? fmt(sa[at]!) : "–"}
            {la && <small> {la}</small>}
          </span>
          {b && (
            <span className="cs">
              <i className="csw b" aria-hidden="true" />
              {at >= 0 && sb[at] != null ? fmt(sb[at]!) : "–"}
              <small> {lb}</small>
            </span>
          )}
        </span>
      </figcaption>
      <div className="chart-body">
        <div className="cy" aria-hidden="true">
          <span>{fmtAxis(top)}</span>
          <span>{fmtAxis(top / 2)}</span>
          <span>0</span>
        </div>
        <div
          className="cplot"
          ref={plotRef}
          onPointerMove={(e) => {
            if (n <= 1) return;
            const r = plotRef.current!.getBoundingClientRect();
            setHover(Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left) / r.width) * (n - 1)))));
          }}
          onPointerLeave={() => setHover(null)}
        >
          <svg viewBox={`0 0 ${w} ${H}`} width={w} height={H} role="img" aria-label={`${title}, last ${m.range}`}>
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" className="cfill-top" />
                <stop offset="100%" className="cfill-bot" />
              </linearGradient>
            </defs>
            <line x1="0" x2={w} y1={PAD_T} y2={PAD_T} className="gl" />
            <line x1="0" x2={w} y1={PAD_T + PLOT_H / 2} y2={PAD_T + PLOT_H / 2} className="gl" />
            <line x1="0" x2={w} y1={PAD_T + PLOT_H} y2={PAD_T + PLOT_H} className="gl base" />
            {pa.area && <path d={pa.area} fill={`url(#${gradId})`} />}
            {pb?.line && <path d={pb.line} className="lb" />}
            {pb?.singles.map((p, idx) => (
              <circle key={`sb${idx}`} cx={p.x} cy={p.y} r="2.2" className="cdot b" />
            ))}
            {pa.line && <path d={pa.line} className="la" />}
            {pa.singles.map((p, idx) => (
              <circle key={`sa${idx}`} cx={p.x} cy={p.y} r="2.2" className="cdot a" />
            ))}
            {hover != null && <line x1={x(hover)} x2={x(hover)} y1={PAD_T} y2={PAD_T + PLOT_H} className="hl" />}
            {hover != null && hvB != null && <circle cx={x(hover)} cy={y(hvB)} r="3.5" className="chov b" />}
            {hover != null && hvA != null && <circle cx={x(hover)} cy={y(hvA)} r="3.5" className="chov a" />}
          </svg>
        </div>
        <div className="cx">
          <span>{n ? label(0) : ""}</span>
          {midIdx > 0 && <span className="cx-mid">{label(midIdx)}</span>}
          <span className={hover != null ? "cx-at" : undefined}>{hover != null ? label(hover) : "now"}</span>
        </div>
      </div>
    </figure>
  );
}

function lastIndex(sa: (number | null)[], sb: (number | null)[]) {
  const n = Math.max(sa.length, sb.length);
  for (let i = n - 1; i >= 0; i--) if (sa[i] != null || sb[i] != null) return i;
  return -1;
}
