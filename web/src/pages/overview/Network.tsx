import { useMemo, useState } from "react";
import { bytes } from "../../api";
import { Seg } from "../../ui";
import { addresses, exposure, handshakeAge, intIp, ports, type Addr, type Info, type Peer, type Tunnel } from "./model";
import { Nothing, Skel, type D } from "./parts";

const label = (a: Addr, multi: boolean) => (multi ? `${a.net.server}/${a.net.name}` : a.net.name);

function IpGrid({ a }: { a: Addr }) {
  const gwIdx = ipIdx(a);
  return (
    <div className="ipg" style={{ gridTemplateColumns: `repeat(${a.cells > 16 ? 16 : a.cells}, minmax(0, 1fr))`, aspectRatio: a.cells >= 16 ? `16 / ${a.cells / 16}` : undefined }} role="img" aria-label={`${a.used} of ${a.total} addresses used`}>
      {Array.from({ length: a.cells }, (_, i) => (
        <i key={i} className={i === 0 || i === a.cells - 1 ? "x" : i === gwIdx ? "gw" : a.usedSet.has(i) ? "u" : ""} title={intIp(a.net.base + i)} />
      ))}
    </div>
  );
}
const ipIdx = (a: Addr) => {
  const n = a.net.gw.split(".").reduce((x, y) => x * 256 + (parseInt(y, 10) || 0), 0);
  return n - a.net.base;
};

function Foot({ a }: { a: Addr }) {
  return (
    <div className="addr-f">
      <span>
        <b>{a.used}</b> <span className="dim">of {a.total} used</span>
      </span>
      {a.nextFree ? (
        <span className="dim">
          next free <span className="mono">{a.nextFree}</span>
        </span>
      ) : (
        <span className="snwarn">no free address</span>
      )}
    </div>
  );
}

export function Addresses({ d, size }: { d: D; size: "s" | "m" }) {
  const [sel, setSel] = useState(0);
  const list = useMemo(() => (d.nets && d.rows ? addresses(d.nets, d.rows) : null), [d.nets, d.rows]);
  if (!list) return <Skel lines={4} />;
  if (!list.length)
    return (
      <>
        <span className="b-t">Addresses</span>
        <Nothing>No managed network with an IPv4 subnet.</Nothing>
      </>
    );
  const multi = new Set(list.map((a) => a.net.server)).size > 1;
  if (size === "s")
    return (
      <>
        <span className="b-t">Addresses</span>
        {list.slice(0, 3).map((a) => (
          <div className="addr-s" key={a.net.server + a.net.name}>
            <small className="dim">{label(a, multi)}</small>
            <div className="big">
              <b>{a.used}</b>
              <span>/ {a.total}</span>
            </div>
            <div className="ipbar" aria-hidden="true">
              <i style={{ width: `${Math.min(100, (a.used / Math.max(1, a.total)) * 100)}%` }} />
            </div>
            {a.nextFree && <small className="dim">Next free {a.nextFree}</small>}
          </div>
        ))}
        {list.length > 3 && <small className="dim">+{list.length - 3} more networks</small>}
      </>
    );
  const idx = Math.min(sel, list.length - 1);
  const a = list[idx];
  return (
    <>
      <div className="b-head">
        <span className="b-t">Addresses</span>
        {list.length > 1 && (
          <span className="b-r">
            <Seg<string>
              label="Network"
              value={String(idx)}
              options={list.map((x, i) => ({ v: String(i), l: label(x, multi) }))}
              onChange={(v) => setSel(Number(v))}
            />
          </span>
        )}
      </div>
      {a.grid ? (
        <IpGrid a={a} />
      ) : (
        <div className="ipbar big-bar" aria-hidden="true">
          <i style={{ width: `${Math.min(100, (a.used / Math.max(1, a.total)) * 100)}%` }} />
        </div>
      )}
      <Foot a={a} />
    </>
  );
}

// ---------- tunnels ----------

function age(ms: number | null) {
  if (ms == null) return "never";
  const s = ms / 1000;
  if (s < 60) return `${Math.max(1, Math.floor(s))} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}

type PeerRow = { p: Peer; t: Tunnel; ms: number | null; up: boolean };
const peerRows = (ts: Tunnel[]): PeerRow[] =>
  ts.flatMap((t) =>
    (t.peers || []).map((p) => {
      const ms = handshakeAge(p.latestHandshake);
      return { p, t, ms, up: ms != null && ms < 3 * 60000 };
    }),
  );

export function Tunnels({ d, size }: { d: D; size: "s" | "m" }) {
  const ts = d.tunnels;
  if (!ts) return null;
  const rows = peerRows(ts);
  const up = rows.filter((r) => r.up).length;
  if (size === "s") {
    const quiet = rows.filter((r) => !r.up).sort((a, b) => (b.ms ?? Infinity) - (a.ms ?? Infinity))[0];
    return (
      <>
        <span className="b-t">Tunnels</span>
        <div className="big">
          <b>{up}</b>
          <span>/ {rows.length} up</span>
        </div>
        <div className="tun-dots">
          {rows.map((r, i) => (
            <span key={i} className={r.up ? "on" : ""} title={r.p.name} />
          ))}
        </div>
        {quiet && <small className="snwarn">{quiet.ms == null ? `${quiet.p.name} not connected` : `${quiet.p.name} quiet ${age(quiet.ms)}`}</small>}
      </>
    );
  }
  return (
    <>
      <div className="b-head">
        <span className="b-t">Tunnels</span>
        <span className="b-r dim">{ts.length === 1 ? `${ts[0].iface}${ts[0].listenPort ? ` · udp ${ts[0].listenPort}` : ""}` : `${ts.length} interfaces`}</span>
      </div>
      <div className="tun">
        {ts.map((t) => {
          const rs = rows.filter((r) => r.t === t);
          return (
            <div key={t.server + t.project + t.instance + t.iface}>
              {ts.length > 1 && (
                <small className="tun-h dim">
                  {t.iface}
                  {t.listenPort ? ` · udp ${t.listenPort}` : ""} · {t.instance}
                </small>
              )}
              {rs.length === 0 && <Nothing>No peers on {t.iface}.</Nothing>}
              {rs.map((r, i) => (
                <div className="tun-r" key={i}>
                  <span className={"tun-s" + (r.up ? " on" : "")} />
                  <div>
                    <b>{r.p.name || (r.p.publicKey || "").slice(0, 8) || "peer"}</b>
                    <small className="mono dim">{r.p.endpoint || "not connected"}</small>
                  </div>
                  <span className="dim tun-x">
                    {r.p.rx != null || r.p.tx != null ? `↓ ${bytes(r.p.rx || 0, 0)}  ↑ ${bytes(r.p.tx || 0, 0)}` : ""}
                  </span>
                  <span className={r.up ? "dim2" : "snwarn"}>{r.ms == null ? "never" : age(r.ms)}</span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </>
  );
}

// ---------- exposure and open ports ----------

function zeroLabel(label: string) {
  if (label.includes("port")) return "open ports";
  if (label.includes("privileged")) return "privileged containers";
  if (label.includes("nesting")) return "nesting";
  return "public API";
}

export function Exposure({ d }: { d: D }) {
  const rows = useMemo(() => (d.rows && d.nets && d.info ? exposure(d.rows, ports(d.rows, d.nets), Object.values(d.info) as Info[]) : null), [d.rows, d.nets, d.info]);
  const active = rows ? rows.filter((r) => r.n > 0) : [];
  const zeros = rows ? rows.filter((r) => r.n === 0).map((r) => zeroLabel(r.label)) : [];
  const zeroLine =
    active.length === 0
      ? "No privileged containers, nesting, open ports or public API."
      : zeros.length > 1
        ? `No ${zeros.slice(0, -1).join(", ")} or ${zeros[zeros.length - 1]}.`
        : zeros.length === 1
          ? `No ${zeros[0]}.`
          : "";
  return (
    <>
      <span className="b-t">Exposure</span>
      {!rows ? (
        <Skel lines={4} />
      ) : (
        <div className="exp">
          {active.map((r) => (
            <div className="exp-r" key={r.label}>
              <span>
                <b className={r.warn ? "snwarn" : ""}>{r.n}</b> {r.label}
              </span>
              <small className="dim">{r.sub}</small>
            </div>
          ))}
          {zeroLine && <p className="none">{zeroLine}</p>}
        </div>
      )}
    </>
  );
}

export function Ports({ d }: { d: D }) {
  const list = useMemo(() => (d.rows && d.nets ? ports(d.rows, d.nets).filter((p) => !p.loop) : null), [d.rows, d.nets]);
  const multi = d.servers.length > 1;
  return (
    <>
      <span className="b-t">Open ports</span>
      {!list ? (
        <Skel lines={4} />
      ) : list.length === 0 ? (
        <Nothing>No proxy devices or network forwards.</Nothing>
      ) : (
        <>
          <div className="pts">
            {list.slice(0, 8).map((p, i) => (
              <div className="pt-r" key={i}>
                <span className="mono pt-p">
                  {p.port}
                  <span>/{p.proto}</span>
                </span>
                <span className="pt-i" title={p.any ? p.inst : `${p.inst} on ${p.host}`}>
                  {p.inst}
                  {(multi || !p.any) && <small className="dim"> {[multi && p.server, !p.any && p.host].filter(Boolean).join(" · ")}</small>}
                </span>
                {p.any && <span className="pub" title="Listening on all interfaces" />}
              </div>
            ))}
          </div>
          {list.length > 8 && <small className="dim">+{list.length - 8} more</small>}
          {list.some((p) => p.any) && (
            <small className="dim">
              <span className="pub" /> listening on all interfaces
            </small>
          )}
        </>
      )}
    </>
  );
}
