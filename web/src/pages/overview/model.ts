// Overview data: fetchers (one per source) and the pure calculations the elements draw from.
import { incus, parseBytes, ui, imageLabel, type ServerStatus } from "../../api";
import { useData } from "../../state";
import type { Row } from "../../data";

const MIN = 60000;
const HOUR = 3600000;
const DAY = 86400000;

// ---------- fetchers ----------

export type Info = { name: string; os: string; version: string; clustered: boolean; cfg: Record<string, string>; update: string };
export type Pool = { names: string[]; driver: string; used: number; total: number };
export type Cap = { server: string; threads: number; memTotal: number; memUsed: number; pools: Pool[]; members: { name: string; status: string }[] };
export type Fwd = { listen: string; ports: { protocol: string; listen_port: string; target_address: string; target_port: string }[] };
export type Net = { server: string; name: string; gw: string; prefix: number; base: number; leases: string[]; forwards: Fwd[] };
export type Img = { server: string; fingerprint: string; aliases: string[]; props: Record<string, string>; created: number; auto: boolean; type: string; arch: string };
export type Peer = { name: string; publicKey?: string; endpoint?: string; allowedIPs?: string[]; latestHandshake?: any; rx?: number; tx?: number };
export type Tunnel = { server: string; project: string; instance: string; iface: string; listenPort?: number; managed?: boolean; peers: Peer[] | null };

const ipInt = (s: string) => s.split(".").reduce((a, b) => a * 256 + (parseInt(b, 10) || 0), 0);
export const intIp = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");

export function useInfo(servers: ServerStatus[], on: boolean) {
  const names = servers.map((s) => s.name).join(",");
  return useData<Record<string, Info>>(
    on && names ? `ov:info:${names}` : null,
    async () => {
      const out: Record<string, Info> = {};
      await Promise.all(
        servers.map(async (s) => {
          const r = await incus<any>(s.name, "/1.0").catch(() => null);
          if (!r) return;
          const env = r.environment || {};
          const cfg: Record<string, string> = r.config || {};
          let update = "";
          try {
            const st = JSON.parse(cfg["user.incus-webui.updates"] || "null");
            if (st?.candidate && st?.installed && st.candidate !== st.installed && st.state !== "error") update = String(st.candidate).replace(/^\d+:/, "").replace(/[-+~].*$/, "");
          } catch {
            /* no helper installed */
          }
          out[s.name] = {
            name: s.name,
            os: [env.os_name, env.os_version].filter(Boolean).join(" ") || s.os || "",
            version: env.server_version || s.version || "",
            clustered: !!env.server_clustered,
            cfg,
            update,
          };
        }),
      );
      return out;
    },
    30000,
  );
}

async function fetchCap(s: ServerStatus): Promise<Cap> {
  const name = s.name;
  let members: Cap["members"] = [];
  let targets: (string | undefined)[] = [undefined];
  if (s.clustered) {
    const ms = await incus<any[]>(name, "/1.0/cluster/members?recursion=1").catch(() => [] as any[]);
    members = (ms || []).map((m) => ({ name: m.server_name, status: m.status }));
    if (members.length) targets = members.filter((m) => m.status === "Online").map((m) => m.name);
  }
  let threads = 0,
    memTotal = 0,
    memUsed = 0;
  await Promise.all(
    targets.map(async (t) => {
      const r = await incus<any>(name, "/1.0/resources" + (t ? `?target=${encodeURIComponent(t)}` : "")).catch(() => null);
      threads += r?.cpu?.total || 0;
      memTotal += r?.memory?.total || 0;
      memUsed += r?.memory?.used || 0;
    }),
  );
  const list = (await incus<any[]>(name, "/1.0/storage-pools?recursion=1").catch(() => [] as any[])) || [];
  const raw = await Promise.all(
    list.map(async (p) => {
      const r = await incus<any>(name, `/1.0/storage-pools/${encodeURIComponent(p.name)}/resources`).catch(() => null);
      return { name: p.name as string, driver: p.driver as string, used: r?.space?.used || 0, total: r?.space?.total || 0, inodes: r?.inodes?.total || 0 };
    }),
  );
  // Directory pools on one disk report the same space. Show that disk once, never add it twice.
  const pools: Pool[] = [];
  const dirs: { p: Pool; inodes: number }[] = [];
  for (const r of raw) {
    if (!r.total) continue;
    if (r.driver === "dir") {
      const same = dirs.find((d) => d.p.total === r.total && d.inodes === r.inodes && Math.abs(d.p.used - r.used) < 8 * 1048576);
      if (same) {
        same.p.names.push(r.name);
        continue;
      }
      const p = { names: [r.name], driver: r.driver, used: r.used, total: r.total };
      dirs.push({ p, inodes: r.inodes });
      pools.push(p);
    } else pools.push({ names: [r.name], driver: r.driver, used: r.used, total: r.total });
  }
  return { server: name, threads, memTotal, memUsed, pools, members };
}

export function useCap(servers: ServerStatus[], on: boolean) {
  const names = servers.map((s) => s.name).join(",");
  return useData<Record<string, Cap>>(
    on && names ? `ov:cap:${names}` : null,
    async () => {
      const out: Record<string, Cap> = {};
      await Promise.all(servers.map(async (s) => void (out[s.name] = await fetchCap(s))));
      return out;
    },
    20000,
  );
}

export function useNets(servers: ServerStatus[], project: string, on: boolean) {
  const names = servers.map((s) => s.name).join(",");
  return useData<Net[]>(
    on && names ? `ov:nets:${names}:${project}` : null,
    async () => {
      const all = await Promise.all(
        servers.map(async (s) => {
          const list = (await incus<any[]>(s.name, "/1.0/networks?recursion=1", { project }).catch(() => [] as any[])) || [];
          const nets = await Promise.all(
            list
              .filter((n) => n.managed)
              .map(async (n): Promise<Net | null> => {
                const m = /^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/.exec(n.config?.["ipv4.address"] || "");
                const forwards = ["bridge", "ovn"].includes(n.type)
                  ? ((await incus<Fwd[]>(s.name, `/1.0/networks/${encodeURIComponent(n.name)}/forwards?recursion=1`, { project }).catch(() => [])) as Fwd[]) || []
                  : [];
                if (!m) return forwards.length ? { server: s.name, name: n.name, gw: "", prefix: 0, base: 0, leases: [], forwards } : null;
                const leases = ((await incus<any[]>(s.name, `/1.0/networks/${encodeURIComponent(n.name)}/leases`, { project }).catch(() => [])) || []).map((l) => l.address as string);
                const prefix = parseInt(m[2], 10);
                const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
                return { server: s.name, name: n.name, gw: m[1], prefix, base: (ipInt(m[1]) & mask) >>> 0, leases, forwards };
              }),
          );
          return nets.filter((n): n is Net => !!n);
        }),
      );
      return all.flat();
    },
    30000,
  );
}

export function useImages(servers: ServerStatus[], project: string, on: boolean) {
  const names = servers.map((s) => s.name).join(",");
  return useData<Img[]>(
    on && names ? `ov:images:${names}:${project}` : null,
    async () => {
      const all = await Promise.all(
        servers.map(async (s) => {
          const list = (await incus<any[]>(s.name, "/1.0/images?recursion=1", { project }).catch(() => [] as any[])) || [];
          return list.map(
            (i): Img => ({
              server: s.name,
              fingerprint: i.fingerprint,
              aliases: (i.aliases || []).map((a: any) => a.name),
              props: i.properties || {},
              created: Date.parse(i.created_at) || 0,
              auto: !!i.auto_update,
              type: i.type || "container",
              arch: i.architecture || "",
            }),
          );
        }),
      );
      return all.flat();
    },
    30000,
  );
}

// null means the tunnels feature is not there (or empty): the element hides itself.
export function useTunnels(on: boolean) {
  return useData<Tunnel[] | null>(on ? "ov:tunnels" : null, async () => {
    try {
      const r = await ui<Tunnel[]>("/tunnels");
      return Array.isArray(r) && r.length ? r : null;
    } catch {
      return null;
    }
  }, 15000);
}

// ---------- cron ----------

type Cron = { m: Set<number> | null; h: Set<number> | null; dom: Set<number> | null; mon: Set<number> | null; dow: Set<number> | null };
const ALIAS: Record<string, string> = { "@hourly": "0 * * * *", "@daily": "0 0 * * *", "@midnight": "0 0 * * *", "@weekly": "0 0 * * 0", "@monthly": "0 0 1 * *", "@yearly": "0 0 1 1 *", "@annually": "0 0 1 1 *" };

function field(s: string, lo: number, hi: number): Set<number> | null {
  if (s === "*" || s === "?") return null;
  const out = new Set<number>();
  for (const part of s.split(",")) {
    const [range, step] = part.split("/");
    let a = lo,
      b = hi;
    if (range !== "*") {
      const [x, y] = range.split("-");
      a = parseInt(x, 10);
      b = y === undefined ? (step ? hi : a) : parseInt(y, 10);
    }
    const st = step ? parseInt(step, 10) : 1;
    if (isNaN(a) || isNaN(b) || isNaN(st) || st < 1 || a < lo || b > hi) throw new Error("bad cron");
    for (let i = a; i <= b; i += st) out.add(i);
  }
  return out;
}

const cronCache = new Map<string, Cron>();
// Unknown forms count as daily.
export function parseCron(spec: string): Cron {
  const key = spec.trim().toLowerCase();
  let c = cronCache.get(key);
  if (c) return c;
  let expr = ALIAS[key] || key;
  const ev = /^every\s+(\d+)\s*h(?:ours?)?$/.exec(key);
  if (ev) expr = `0 */${ev[1]} * * *`;
  else if (/^every\s+hour$/.test(key)) expr = ALIAS["@hourly"];
  try {
    const f = expr.split(/\s+/);
    if (f.length !== 5) throw new Error("bad cron");
    const dow = field(f[4], 0, 7);
    if (dow?.has(7)) dow.add(0);
    c = { m: field(f[0], 0, 59), h: field(f[1], 0, 23), dom: field(f[2], 1, 31), mon: field(f[3], 1, 12), dow };
  } catch {
    c = parseCron("@daily");
  }
  cronCache.set(key, c);
  return c;
}

function matches(c: Cron, d: Date) {
  if (c.m && !c.m.has(d.getMinutes())) return false;
  if (c.h && !c.h.has(d.getHours())) return false;
  if (c.mon && !c.mon.has(d.getMonth() + 1)) return false;
  const dm = !c.dom || c.dom.has(d.getDate());
  const dw = !c.dow || c.dow.has(d.getDay());
  return c.dom && c.dow ? dm || dw : dm && dw;
}

export function runsBetween(spec: string, from: number, to: number): number[] {
  const c = parseCron(spec);
  const out: number[] = [];
  for (let t = Math.ceil(from / MIN) * MIN; t <= to; t += MIN) if (matches(c, new Date(t))) out.push(t);
  return out;
}

const gapCache = new Map<string, number>();
// The longest normal wait between two runs, in ms.
export function intervalMs(spec: string): number {
  const k = spec.trim().toLowerCase();
  let g = gapCache.get(k);
  if (g) return g;
  const runs = runsBetween(k, Date.now(), Date.now() + 35 * DAY);
  g = DAY;
  if (runs.length > 1) {
    g = 0;
    for (let i = 1; i < runs.length; i++) g = Math.max(g, runs[i] - runs[i - 1]);
  }
  gapCache.set(k, g);
  return g;
}

export function every(ms: number) {
  if (ms < HOUR) return `${Math.round(ms / MIN)} min`;
  if (ms < DAY) return `${+(ms / HOUR).toFixed(1)} h`;
  return ms === DAY ? "day" : `${+(ms / DAY).toFixed(1)} days`;
}

// ---------- snapshots ----------

export type SnapInfo = { row: Row; scheduled: boolean; bad: boolean; label: string };
const valid = (iso?: string) => !!iso && !iso.startsWith("0001") && !isNaN(Date.parse(iso));

export function snapHealth(rows: Row[], now = Date.now()): SnapInfo[] {
  return rows.map((row) => {
    const c = row.expanded_config || {};
    const sched = (c["snapshots.schedule"] || "").trim();
    if (!sched || sched === "@never") return { row, scheduled: false, bad: false, label: "" };
    // Stopped instances are skipped by Incus unless asked for.
    if (row.status === "Stopped" && c["snapshots.schedule.stopped"] !== "true") return { row, scheduled: true, bad: false, label: "" };
    const iv = intervalMs(sched);
    const snaps = (row.snapshots || []).map((s) => Date.parse(s.created_at)).filter((t) => !isNaN(t));
    const newest = snaps.length ? Math.max(...snaps) : 0;
    const ref = newest || Date.parse(row.created_at) || now;
    if (now - ref <= 2 * iv) return { row, scheduled: true, bad: false, label: "" };
    return { row, scheduled: true, bad: true, label: newest ? `missed ${Math.floor((now - newest) / iv)} runs` : "never" };
  });
}

// ---------- next 24 hours ----------

export type TlLine = { at: number; kind: string; text: string };
export type TlGroup = { at: number; lines: TlLine[]; dots: number[] };
export type Timeline = { groups: TlGroup[]; legend: { text: string; tick: boolean }[]; ticks: number[] };

export function timeline(rows: Row[], images: Img[] | undefined, infos: Info[], now = Date.now()): Timeline {
  const end = now + DAY;
  type Ev = { at: number; kind: string; who: string };
  const evs: Ev[] = [];
  const legend: Timeline["legend"] = [];
  const ticks: number[] = [];
  const bySched = new Map<string, string[]>();
  for (const s of snapHealth(rows, now)) {
    const c = s.row.expanded_config || {};
    if (!s.scheduled) continue;
    if (s.row.status === "Stopped" && c["snapshots.schedule.stopped"] !== "true") continue;
    const k = c["snapshots.schedule"].trim();
    bySched.set(k, [...(bySched.get(k) || []), s.row.name]);
  }
  for (const [spec, who] of bySched) {
    const runs = runsBetween(spec, now, end);
    if (runs.length > 3) {
      const names = who.length === 1 ? who[0] : who.length <= 3 ? who.join(", ") : `${who.length} instances`;
      legend.push({ text: `${names} snapshot, every ${every(runs[1] - runs[0])}`, tick: true });
      if (runs.length <= 48) ticks.push(...runs); // a tick a minute is just a smear
    } else runs.forEach((at) => who.forEach((w) => evs.push({ at, kind: "Snapshots", who: w })));
  }
  for (const r of rows)
    for (const sn of r.snapshots || []) {
      const t = valid(sn.expires_at) ? Date.parse(sn.expires_at) : 0;
      if (t > now && t <= end) evs.push({ at: t, kind: "Expire", who: `${r.name}/${sn.name}` });
    }
  const withAuto = (images || []).some((i) => i.auto);
  if (withAuto) {
    const hs = infos.map((i) => parseFloat(i.cfg["images.auto_update_interval"] ?? "6")).map((h) => (isNaN(h) ? 6 : h)).filter((h) => h > 0);
    if (hs.length) legend.push({ text: `Image refresh every ${every(Math.min(...hs) * HOUR)}`, tick: false });
  }
  evs.sort((a, b) => a.at - b.at);
  const groups: TlGroup[] = [];
  for (const e of evs) {
    let g = groups[groups.length - 1];
    if (!g || e.at - g.at > 4 * HOUR) groups.push((g = { at: e.at, lines: [], dots: [] }));
    g.dots.push(e.at);
    let l = g.lines.find((x) => x.kind === e.kind);
    if (!l) g.lines.push((l = { at: e.at, kind: e.kind, text: "" }));
    (l as any).who = [...((l as any).who || []), e.who];
  }
  for (const g of groups)
    for (const l of g.lines) {
      const who: string[] = (l as any).who;
      l.text = who.length === 1 ? who[0] : `${who.length} ${l.kind === "Expire" ? "snapshots" : "instances"}`;
      delete (l as any).who;
    }
  return { groups, legend, ticks };
}

// ---------- addresses ----------

export type Addr = { net: Net; total: number; used: number; grid: boolean; cells: number; usedSet: Set<number>; nextFree: string };

export function addresses(nets: Net[], rows: Row[]): Addr[] {
  const out: Addr[] = [];
  for (const net of nets) {
    if (!net.gw) continue;
    const size = Math.pow(2, 32 - net.prefix);
    const used = new Set<number>();
    for (const a of net.leases) used.add(ipInt(a) - net.base);
    for (const r of rows)
      if (r.server === net.server)
        for (const d of Object.values(r.expanded_devices || {})) {
          if (d.type !== "nic" || d.network !== net.name || !/^\d+\.\d+\.\d+\.\d+$/.test(d["ipv4.address"] || "")) continue;
          used.add(ipInt(d["ipv4.address"]) - net.base);
        }
    const gw = ipInt(net.gw) - net.base;
    used.delete(gw);
    used.delete(0);
    used.delete(size - 1);
    for (const u of [...used]) if (u < 0 || u >= size) used.delete(u);
    let next = "";
    for (let i = 1; i < size - 1; i++)
      if (i !== gw && !used.has(i)) {
        next = intIp(net.base + i);
        break;
      }
    out.push({ net, total: Math.max(0, size - 3), used: used.size, grid: net.prefix >= 24 && net.prefix <= 30, cells: size, usedSet: used, nextFree: next });
  }
  return out;
}

// ---------- ports and exposure ----------

export type Port = { server: string; inst: string; proto: string; port: string; host: string; any: boolean; loop: boolean; kind: "proxy" | "forward" };
const isLoop = (h: string) => /^127\./.test(h) || h === "::1" || h === "[::1]" || h === "localhost";
const isAny = (h: string) => h === "" || h === "0.0.0.0" || h === "::" || h === "[::]";

export function ports(rows: Row[], nets: Net[]): Port[] {
  const out: Port[] = [];
  for (const r of rows)
    for (const d of Object.values(r.expanded_devices || {})) {
      if (d.type !== "proxy" || d.bind === "instance") continue;
      const m = /^(tcp|udp):(\[[^\]]*\]|[^:]*):(.+)$/.exec(d.listen || "");
      if (!m) continue;
      out.push({ server: r.server, inst: r.name, proto: m[1], port: m[3], host: m[2], any: isAny(m[2]), loop: isLoop(m[2]), kind: "proxy" });
    }
  for (const n of nets)
    for (const f of n.forwards || [])
      for (const p of f.ports || [])
        out.push({ server: n.server, inst: p.target_address, proto: p.protocol, port: p.listen_port, host: f.listen, any: isAny(f.listen), loop: isLoop(f.listen), kind: "forward" });
  return out.sort((a, b) => Number(b.any) - Number(a.any) || (parseInt(a.port, 10) || 0) - (parseInt(b.port, 10) || 0));
}

export type ExpRow = { n: number; label: string; sub: string; warn?: boolean };
export function exposure(rows: Row[], pts: Port[], infos: Info[]): ExpRow[] {
  const open = pts.filter((p) => !p.loop);
  const byInst = new Map<string, string[]>();
  open.forEach((p) => byInst.set(p.inst, [...(byInst.get(p.inst) || []), p.port]));
  const groups = [...byInst].map(([i, ps]) => `${i} ${[...new Set(ps)].join(", ")}`);
  const priv = rows.filter((r) => r.expanded_config?.["security.privileged"] === "true").map((r) => r.name);
  const nest = rows.filter((r) => r.expanded_config?.["security.nesting"] === "true").map((r) => r.name);
  const wide = infos.filter((i) => /^(0\.0\.0\.0|\[::\])?:\d+$/.test(i.cfg["core.https_address"] || ""));
  const some = (l: string[]) => (l.length > 3 ? `${l.slice(0, 3).join(", ")} +${l.length - 3}` : l.join(", "));
  const addr = infos.map((i) => i.cfg["core.https_address"]).filter(Boolean);
  return [
    { n: open.length, label: open.length === 1 ? "port open beyond this host" : "ports open beyond this host", sub: groups.length ? some(groups) : "Only reachable from the host itself" },
    { n: priv.length, label: priv.length === 1 ? "privileged container" : "privileged containers", sub: priv.length ? some(priv) : "None", warn: priv.length > 0 },
    { n: nest.length, label: nest.length === 1 ? "instance with nesting on" : "instances with nesting on", sub: nest.length ? some(nest) : "None" },
    {
      n: wide.length,
      label: "Incus API listens on all interfaces",
      sub: wide.length ? (infos.length > 1 ? some(wide.map((i) => i.name)) : wide[0].cfg["core.https_address"]) : addr.length ? `only on ${[...new Set(addr)].join(", ")}` : "Not listening on the network",
    },
  ];
}

// ---------- boot order ----------

export type Stage = { priority: number; names: string[]; delay: number };
export function bootOrder(rows: Row[]) {
  const by = new Map<number, Stage>();
  let off = 0;
  for (const r of rows) {
    const c = r.expanded_config || {};
    if (c["boot.autostart"] !== "true") {
      off++;
      continue;
    }
    const p = parseInt(c["boot.autostart.priority"] || "0", 10) || 0;
    const d = parseInt(c["boot.autostart.delay"] || "0", 10) || 0;
    const s = by.get(p) || { priority: p, names: [], delay: 0 };
    s.names.push(r.name);
    s.delay = Math.max(s.delay, d);
    by.set(p, s);
  }
  return { stages: [...by.values()].sort((a, b) => b.priority - a.priority), off };
}

// ---------- base images ----------

export type BaseImg = { label: string; count: number; days: number | null; newer: boolean };
export function baseImages(rows: Row[], images: Img[], now = Date.now()): BaseImg[] {
  const groups = new Map<string, BaseImg & { img?: Img }>();
  for (const r of rows) {
    const fp = r.config?.["volatile.base_image"];
    if (!fp) continue;
    const k = `${r.server}:${fp}`;
    let g = groups.get(k);
    if (!g) {
      const img = images.find((i) => i.server === r.server && i.fingerprint === fp);
      const label = imageLabel(r) || img?.aliases[0] || img?.props.description || fp.slice(0, 12);
      g = { label, count: 0, days: img?.created ? Math.max(0, Math.floor((now - img.created) / DAY)) : null, newer: false, img };
      groups.set(k, g);
    }
    g.count++;
  }
  for (const g of groups.values()) {
    const i = g.img;
    if (!i) continue;
    g.newer = images.some(
      (o) =>
        o.server === i.server &&
        o.fingerprint !== i.fingerprint &&
        o.created > i.created &&
        o.type === i.type &&
        ((o.props.os && o.props.os === i.props.os && o.props.release === i.props.release && (o.props.variant || "") === (i.props.variant || "") && o.arch === i.arch) || (i.aliases[0] && o.aliases.includes(i.aliases[0]))),
    );
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)).map(({ img, ...g }) => g);
}

// ---------- capacity ----------

export function cpuCount(v: string | undefined): number {
  if (!v) return 0;
  if (/^\d+$/.test(v)) return parseInt(v, 10);
  let n = 0;
  for (const p of v.split(",")) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(p.trim());
    if (m) n += m[2] ? parseInt(m[2], 10) - parseInt(m[1], 10) + 1 : 1;
  }
  return n;
}

export function limits(rows: Row[], memTotal: number) {
  let cpu = 0,
    mem = 0;
  for (const r of rows) {
    if (r.status === "Stopped") continue;
    const c = r.expanded_config || {};
    cpu += cpuCount(c["limits.cpu"]);
    const m = c["limits.memory"] || "";
    mem += m.endsWith("%") ? (parseFloat(m) / 100) * memTotal : parseBytes(m) || 0;
  }
  return { cpu, mem };
}

// A WireGuard handshake time as milliseconds ago; null when there never was one.
export function handshakeAge(v: any, now = Date.now()): number | null {
  if (v == null || v === "" || v === 0 || v === "0") return null;
  let t: number;
  if (typeof v === "number") t = v > 1e12 ? v : v > 1e9 ? v * 1000 : now - v * 1000;
  else {
    t = Date.parse(v);
    if (isNaN(t)) return null;
  }
  if (t < 1e10) return null;
  return Math.max(0, now - t);
}
