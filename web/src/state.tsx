import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ic } from "./icons";
import { friendlyError, ui, type ServerStatus } from "./api";

// ---------- data fetching with a shared cache (stale-while-revalidate) ----------

type Entry = { data?: any; error?: string; at: number; loading: boolean; p?: Promise<void>; stale?: boolean };
const cache = new Map<string, Entry>();
const subs = new Map<string, Set<() => void>>();
function notify(key: string) {
  subs.get(key)?.forEach((f) => f());
}
// While set, errors from app.run go here instead of a toast (a dialog shows them itself).
let errSink: ((e: unknown) => void) | null = null;
export function setErrorSink(fn: ((e: unknown) => void) | null) {
  errSink = fn;
}

export function invalidate(prefix: string) {
  for (const k of cache.keys()) if (k.startsWith(prefix)) {
    const e = cache.get(k)!;
    e.at = 0;
    // a load already in flight may carry data from before the change
    if (e.p) e.stale = true;
    notify(k);
  }
}
export function cacheGet<T>(key: string): T | undefined {
  return cache.get(key)?.data as T | undefined;
}
export function mutateCache(key: string, fn: (d: any) => any) {
  const e = cache.get(key);
  if (e && e.data !== undefined) {
    e.data = fn(e.data);
    notify(key);
  }
}

export function useData<T>(key: string | null, fetcher: () => Promise<T>, interval = 0) {
  const [, force] = useState(0);
  const fRef = useRef(fetcher);
  fRef.current = fetcher;

  const load = useCallback(() => {
    if (!key) return Promise.resolve();
    let e = cache.get(key);
    if (!e) {
      e = { at: 0, loading: false };
      cache.set(key, e);
    }
    if (e.p) return e.p;
    e.loading = true;
    notify(key);
    const entry = e;
    entry.p = fRef.current().then(
      (d) => {
        entry.data = d;
        entry.error = undefined;
      },
      (err) => {
        entry.error = err instanceof Error ? err.message : String(err);
      },
    ).finally(() => {
      entry.loading = false;
      entry.at = entry.stale ? 0 : Date.now();
      entry.stale = false;
      entry.p = undefined;
      notify(key);
    });
    return entry.p;
  }, [key]);

  useEffect(() => {
    if (!key) return;
    const f = () => force((n) => n + 1);
    if (!subs.has(key)) subs.set(key, new Set());
    subs.get(key)!.add(f);
    const e = cache.get(key);
    if (!e || Date.now() - e.at > 2000) load();
    let t: number | undefined;
    if (interval) t = window.setInterval(() => !document.hidden && load(), interval);
    return () => {
      subs.get(key)?.delete(f);
      if (t) clearInterval(t);
    };
  }, [key, interval, load]);

  // reload when invalidated
  const e = key ? cache.get(key) : undefined;
  useEffect(() => {
    if (key && e && e.at === 0 && !e.p) load();
  });
  return { data: e?.data as T | undefined, error: e?.error, loading: !!e?.loading, at: e?.at || 0, reload: load };
}

// ---------- app-wide state ----------

export type Mode = "auto" | "light" | "dark";
export type Theme = { name: "graphite" | "harbor" | "custom"; accent?: string };
type Toast = { id: number; msg: string; err?: boolean; title?: string; action?: { label: string; fn: () => void }; out?: boolean };
type Task = { id: number; label: string; detail?: string };

export type RoleName = "viewer" | "operator" | "manager" | "admin";
export type AccessEntry = { who: string; server: string; project: string; role: RoleName };
const roleRank: Record<string, number> = { viewer: 1, operator: 2, manager: 3, admin: 4 };

type Ctx = {
  user: string;
  method: string;
  admin: boolean;
  // can tells whether you have at least this role on a server and project.
  // The backend checks too; this only decides what to show.
  can: (server: string, project: string, role: RoleName) => boolean;
  servers: ServerStatus[];
  serversLoaded: boolean;
  reloadServers: () => Promise<void>;
  scope: string; // server name or "*" for all
  setScope: (s: string) => void;
  project: string;
  setProject: (p: string) => void;
  mode: Mode;
  setMode: (m: Mode) => void;
  theme: Theme;
  setTheme: (t: Theme) => void;
  toast: (msg: string, action?: Toast["action"]) => void;
  fail: (err: unknown, title?: string) => void;
  tasks: Task[];
  run: <T>(label: string, fn: (progress: (detail: string) => void) => Promise<T>, done?: string) => Promise<T | undefined>;
  lastUpdate: number;
  touch: () => void;
};

const AppCtx = createContext<Ctx>(null as any);
export const useApp = () => useContext(AppCtx);

function ls(key: string, d: string) {
  try {
    return localStorage.getItem(key) || d;
  } catch {
    return d;
  }
}
function lsSet(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* private mode */
  }
}

export function applyTheme(theme: Theme, mode: Mode) {
  const html = document.documentElement;
  html.classList.add("switching");
  if (mode === "auto") html.removeAttribute("data-theme");
  else html.setAttribute("data-theme", mode);
  if (theme.name === "graphite") html.removeAttribute("data-brand");
  else html.setAttribute("data-brand", theme.name);
  if (theme.name === "custom" && theme.accent) {
    const { light, dark } = accentPair(theme.accent);
    html.style.setProperty("--cl", light);
    html.style.setProperty("--cd", dark);
    html.style.setProperty("--cli", inkFor(light));
    html.style.setProperty("--cdi", inkFor(dark));
  }
  requestAnimationFrame(() => requestAnimationFrame(() => html.classList.remove("switching")));
}

// --- contrast helpers for the custom accent ---
function hexToRgb(h: string) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function lum(h: string) {
  const [r, g, b] = hexToRgb(h).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a: string, b: string) {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
function mix(h: string, to: number, t: number) {
  return "#" + hexToRgb(h).map((v) => Math.round(v + (to - v) * t).toString(16).padStart(2, "0")).join("");
}
// accentPair darkens the colour for light mode and lightens it for dark mode
// until it reaches 4.5:1 against the page background.
export function accentPair(hex: string) {
  let light = hex;
  for (let i = 0; i < 20 && contrast(light, "#f5f5f7") < 4.5; i++) light = mix(light, 0, 0.08);
  let dark = hex;
  for (let i = 0; i < 20 && contrast(dark, "#0e0e10") < 4.5; i++) dark = mix(dark, 255, 0.1);
  return { light, dark };
}
function inkFor(bg: string) {
  return contrast(bg, "#ffffff") >= contrast(bg, "#0e0e10") ? "#ffffff" : "#0e0e10";
}

export function AppProvider({ user, method, initialTheme, children }: { user: string; method: string; initialTheme: Theme; children: ReactNode }) {
  const [servers, setServers] = useState<ServerStatus[]>([]);
  const [serversLoaded, setLoaded] = useState(false);
  const [scope, setScopeS] = useState(ls("iwui.scope", "*"));
  const [project, setProjectS] = useState(ls("iwui.project", "default"));
  const [mode, setModeS] = useState<Mode>(ls("iwui.mode", "auto") as Mode);
  const [theme, setThemeS] = useState<Theme>(initialTheme);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [lastUpdate, setLast] = useState(Date.now());
  const seq = useRef(1);
  const [me, setMe] = useState<{ admin: boolean; access: AccessEntry[] }>({ admin: false, access: [] });
  useEffect(() => {
    ui<{ admin: boolean; access: AccessEntry[] }>("/me").then(setMe, () => {});
  }, []);
  const can = useCallback(
    (server: string, project: string, role: RoleName) => {
      if (me.admin) return true;
      return me.access.some((a) => roleRank[a.role] >= roleRank[role] && (a.server === "*" || a.server === server) && (a.project === "*" || a.project === project || project === "*"));
    },
    [me],
  );

  const reloadServers = useCallback(async () => {
    try {
      const s = await ui<ServerStatus[]>("/servers");
      setServers(s);
    } finally {
      setLoaded(true);
    }
  }, []);
  useEffect(() => {
    reloadServers();
    const t = setInterval(() => !document.hidden && reloadServers(), 30000);
    return () => clearInterval(t);
  }, [reloadServers]);

  useEffect(() => applyTheme(theme, mode), [theme, mode]);

  const toast = useCallback((msg: string, action?: Toast["action"]) => {
    const id = seq.current++;
    setToasts((t) => [...t.slice(-2), { id, msg, action }]);
    setTimeout(() => setToasts((t) => t.map((x) => (x.id === id ? { ...x, out: true } : x))), action ? 6000 : 3500);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), action ? 6250 : 3750);
  }, []);

  // Errors stay until dismissed.
  const fail = useCallback((err: unknown, title?: string) => {
    const msg = friendlyError(err);
    const id = seq.current++;
    setToasts((t) => [...t.filter((x) => !(x.err && x.msg === msg && x.title === title)).slice(-3), { id, msg, title, err: true }]);
  }, []);

  const run = useCallback(
    async <T,>(label: string, fn: (progress: (detail: string) => void) => Promise<T>, done?: string) => {
      const id = seq.current++;
      const started = Date.now();
      setTasks((t) => [...t, { id, label }]);
      const progress = (detail: string) => setTasks((t) => t.map((x) => (x.id === id ? { ...x, detail } : x)));
      // Every action lands in the task history, so people can look back at what they did.
      const record = (body: { state: "done" | "failed"; note?: string; error?: string }) =>
        ui("/jobs", { method: "POST", body: { title: label, took: Date.now() - started, ...body } })
          .catch(() => {})
          .then(() => invalidate("ui-jobs"));
      try {
        const r = await fn(progress);
        if (done) toast(done);
        record({ state: "done", note: done });
        return r;
      } catch (e) {
        if (errSink) errSink(e);
        else fail(e);
        record({ state: "failed", error: friendlyError(e) });
        return undefined;
      } finally {
        setTasks((t) => t.filter((x) => x.id !== id));
      }
    },
    [toast, fail],
  );

  const ctx: Ctx = {
    user,
    method,
    admin: me.admin,
    can,
    servers,
    serversLoaded,
    reloadServers,
    scope,
    setScope: (s) => {
      setScopeS(s);
      lsSet("iwui.scope", s);
    },
    project,
    setProject: (p) => {
      setProjectS(p);
      lsSet("iwui.project", p);
    },
    mode,
    setMode: (m) => {
      setModeS(m);
      lsSet("iwui.mode", m);
    },
    theme,
    setTheme: setThemeS,
    toast,
    fail,
    tasks,
    run,
    lastUpdate,
    touch: () => setLast(Date.now()),
  };

  return (
    <AppCtx.Provider value={ctx}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={"toast" + (t.out ? " out" : "") + (t.err ? " err" : "")} role={t.err ? "alert" : undefined}>
            {t.err && <span className="ti">{ic.warn}</span>}
            <span className="tm">
              {t.title && <b>{t.title}</b>}
              {t.msg}
            </span>
            {t.err && (
              <button
                aria-label="Dismiss"
                onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}
              >
                Dismiss
              </button>
            )}
            {t.action && (
              <button
                onClick={() => {
                  t.action!.fn();
                  setToasts((x) => x.filter((y) => y.id !== t.id));
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </AppCtx.Provider>
  );
}

// servers the current scope covers (only reachable + trusted ones)
export function useScopedServers() {
  const { servers, scope } = useApp();
  return servers.filter((s) => s.online && s.trusted && (scope === "*" || s.name === scope));
}
