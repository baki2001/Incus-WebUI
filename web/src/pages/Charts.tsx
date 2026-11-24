import { useRef, useState } from "react";
import { bytes, ui } from "../api";
import { useData } from "../state";
import { Seg } from "../ui";

type Range = "1h" | "24h" | "7d";
type Metrics = { start: number; step: number; range: Range; instances: number; series: Record<"cpu" | "mem" | "rx" | "tx" | "rd" | "wr", (number | null)[]> };

const rate = (n: number) => bytes(n) + "/s";
const cores = (n: number) => (n < 0.1 ? `${Math.round(n * 1000) / 10}%` : `${Math.round(n * 100) / 100} cores`).replace("%", "% of a core");

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
            <Chart title="CPU" m={m} a="cpu" fmt={cores} />
            <Chart title="Memory" m={m} a="mem" fmt={(n) => bytes(n)} />
            <Chart title="Network" m={m} a="rx" b="tx" la="in" lb="out" fmt={rate} />
            {(has("rd") || has("wr")) && <Chart title="Disk" m={m} a="rd" b="wr" la="read" lb="write" fmt={rate} />}
          </div>
        )}
      </div>
    </div>
  );
}

const W = 320,
  H = 96;

function Chart({ title, m, a, b, la, lb, fmt }: { title: string; m: Metrics; a: keyof Metrics["series"]; b?: keyof Metrics["series"]; la?: string; lb?: string; fmt: (n: number) => string }) {
  const sa = m.series[a] || [];
  const sb = b ? m.series[b] || [] : [];
  const n = Math.max(sa.length, sb.length);
  const top = Math.max(1e-9, ...sa.map((v) => v ?? 0), ...sb.map((v) => v ?? 0)) * 1.1;
  const x = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * W);
  const y = (v: number) => H - (v / top) * H;
  const path = (s: (number | null)[]) => {
    let d = "";
    let pen = false;
    s.forEach((v, i) => {
      if (v == null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  const at = hover ?? lastIndex(sa);
  const time = (i: number) => new Date((m.start + i * m.step) * 1000);
  const label = (i: number) => {
    const t = time(i);
    return m.range === "7d" ? t.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" }) : t.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  };
  return (
    <figure className="chart">
      <figcaption>
        <span>{title}</span>
        <span className="cv">
          {at >= 0 && sa[at] != null ? fmt(sa[at]!) : "–"}
          {la && <small> {la}</small>}
          {b && (
            <>
              {" · "}
              {at >= 0 && sb[at] != null ? fmt(sb[at]!) : "–"}
              <small> {lb}</small>
            </>
          )}
        </span>
      </figcaption>
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${title}, last ${m.range}`}
        onPointerMove={(e) => {
          const r = ref.current!.getBoundingClientRect();
          setHover(Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left) / r.width) * (n - 1)))));
        }}
        onPointerLeave={() => setHover(null)}
      >
        <line x1="0" x2={W} y1={H / 2} y2={H / 2} className="gl" />
        {b && <path d={path(sb)} className="lb" />}
        <path d={path(sa)} className="la" />
        {hover != null && <line x1={x(hover)} x2={x(hover)} y1="0" y2={H} className="hl" />}
      </svg>
      <div className="cx">
        <span>{n ? label(0) : ""}</span>
        <span>{hover != null ? label(hover) : "now"}</span>
      </div>
    </figure>
  );
}

function lastIndex(s: (number | null)[]) {
  for (let i = s.length - 1; i >= 0; i--) if (s[i] != null) return i;
  return -1;
}
