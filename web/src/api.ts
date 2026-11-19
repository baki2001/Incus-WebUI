// Thin client for our backend and the proxied Incus API.

export class ApiError extends Error {
  status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.status = status;
  }
}

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

export async function ui<T = any>(path: string, opts: { method?: string; body?: any } = {}): Promise<T> {
  const res = await fetch("/api/ui" + path, {
    method: opts.method || "GET",
    headers: { "X-Incus-UI": "1", ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: "same-origin",
  });
  if (res.status === 401 && path !== "/login" && path !== "/auth") onUnauthorized();
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || res.statusText);
  return data as T;
}

function withProject(path: string, project?: string) {
  if (!project) return path;
  if (/[?&](project|all-projects)=/.test(path)) return path;
  return path + (path.includes("?") ? "&" : "?") + "project=" + encodeURIComponent(project);
}

export function incusURL(server: string, path: string, project?: string) {
  return `/api/s/${encodeURIComponent(server)}${withProject(path, project)}`;
}

type ReqOpts = { method?: string; body?: any; project?: string; headers?: Record<string, string>; raw?: BodyInit; signal?: AbortSignal };

// incus calls the Incus REST API and returns `metadata`; async operations are
// returned as-is (use `incusOp` to wait for them).
export async function incusRaw(server: string, path: string, o: ReqOpts = {}): Promise<Response> {
  const headers: Record<string, string> = { "X-Incus-UI": "1", ...(o.headers || {}) };
  let body: BodyInit | undefined = o.raw;
  if (o.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(o.body);
  }
  const res = await fetch(incusURL(server, path, o.project), { method: o.method || "GET", headers, body, credentials: "same-origin", signal: o.signal });
  if (res.status === 401) {
    const j = await res.clone().json().catch(() => ({}));
    if (j.error === "not signed in") onUnauthorized();
  }
  return res;
}

export async function incus<T = any>(server: string, path: string, o: ReqOpts = {}): Promise<T> {
  const res = await incusRaw(server, path, o);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.type === "error") throw new ApiError(res.status, data.error || res.statusText);
  return data.metadata as T;
}

export type Operation = {
  id: string;
  description: string;
  status: string;
  status_code: number;
  err: string;
  metadata: any;
  resources?: Record<string, string[]>;
};

// incusOp sends a request that may start an async operation and waits for it.
export async function incusOp(server: string, path: string, o: ReqOpts = {}, onStart?: (op: Operation) => void): Promise<Operation | any> {
  const res = await incusRaw(server, path, o);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.type === "error") throw new ApiError(res.status, data.error || res.statusText);
  if (data.type !== "async") return data.metadata;
  const op = data.metadata as Operation;
  onStart?.(op);
  return waitOp(server, op.id, o.project);
}

export async function waitOp(server: string, id: string, project?: string): Promise<Operation> {
  for (;;) {
    const op = await incus<Operation>(server, `/1.0/operations/${id}/wait?timeout=30`, { project });
    if (op.status_code >= 200) {
      if (op.status_code !== 200) throw new ApiError(400, op.err || op.status);
      return op;
    }
  }
}

export function wsURL(server: string, opID: string, secret: string, project?: string) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${incusURL(server, `/1.0/operations/${opID}/websocket?secret=${encodeURIComponent(secret)}`, project)}`;
}

// --- types (only the fields we use) ---

export type Instance = {
  name: string;
  type: "container" | "virtual-machine";
  status: string;
  status_code: number;
  description: string;
  architecture: string;
  created_at: string;
  last_used_at: string;
  location: string;
  project: string;
  profiles: string[];
  ephemeral: boolean;
  stateful: boolean;
  config: Record<string, string>;
  devices: Record<string, Record<string, string>>;
  expanded_config: Record<string, string>;
  expanded_devices: Record<string, Record<string, string>>;
  state?: InstanceState | null;
  snapshots?: Snapshot[] | null;
};

export type InstanceState = {
  status: string;
  pid: number;
  processes: number;
  cpu: { usage: number };
  memory: { usage: number; usage_peak: number; total: number };
  disk: Record<string, { usage: number; total?: number }> | null;
  network: Record<string, { addresses: { family: string; address: string; scope: string }[]; hwaddr: string; host_name: string; type: string; counters: { bytes_received: number; bytes_sent: number } }> | null;
};

export type Snapshot = { name: string; created_at: string; expires_at: string; stateful: boolean; size: number };

export type ServerStatus = {
  name: string;
  url: string;
  online: boolean;
  trusted: boolean;
  error?: string;
  version?: string;
  os?: string;
  server_name?: string;
  clustered?: boolean;
  incus_os?: boolean;
  fingerprint?: string;
};

// --- formatting helpers ---

export function bytes(n: number | undefined | null, digits = 1): string {
  if (n == null || isNaN(n)) return "–";
  const u = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(digits)} ${u[i]}`;
}

export function parseBytes(s: string | undefined): number | null {
  if (!s) return null;
  const m = /^\s*([\d.]+)\s*([KMGTPE]?)(i?)B?\s*$/i.exec(s);
  if (!m) return null;
  const pow = "BKMGTPE".indexOf(m[2].toUpperCase() || "B");
  const base = m[3] || !m[2] ? 1024 : 1000;
  return parseFloat(m[1]) * Math.pow(base, Math.max(pow, 0));
}

export function since(iso: string | undefined): string {
  if (!iso || iso.startsWith("0001") || iso.startsWith("1970")) return "–";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  const d = Math.floor(s / 86400);
  return `${d} day${d === 1 ? "" : "s"}`;
}

export function dateTime(iso: string | undefined): string {
  if (!iso || iso.startsWith("0001") || iso.startsWith("1970")) return "–";
  return new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function ipv4(inst: Instance): string {
  const net = inst.state?.network;
  if (!net) return "";
  for (const [name, n] of Object.entries(net)) {
    if (name === "lo") continue;
    const a = n.addresses.find((a) => a.family === "inet" && a.scope === "global");
    if (a) return a.address;
  }
  return "";
}

export function imageLabel(inst: Instance): string {
  const c = inst.config || {};
  const os = c["image.os"] || "";
  const rel = c["image.release"] || "";
  const variant = c["image.variant"] && c["image.variant"] !== "default" ? "/" + c["image.variant"] : "";
  return os ? `${os.toLowerCase()}/${rel}${variant}` : c["image.description"] || "";
}

export function stateClass(status: string): string {
  switch (status) {
    case "Running":
      return "running";
    case "Frozen":
      return "frozen";
    case "Error":
      return "error";
    case "Stopped":
      return "";
    default:
      return "busy";
  }
}
