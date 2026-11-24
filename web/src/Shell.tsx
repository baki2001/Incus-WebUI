import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { incus, incusOp, since, ui } from "./api";
import { ic, Mark } from "./icons";
import { invalidate, useApp, useData, useScopedServers, type Mode } from "./state";
import { ConfirmHost, Dialog, useOutside } from "./ui";
import { canDo } from "./pages/Instances";
import { askStop, StopHost } from "./pages/InstanceDialogs";
import { usePins, useInstances, useProjects } from "./data";

// ---------- breadcrumbs, set by each page ----------
type Crumb = { label: string; to?: string };
let setCrumbsGlobal: (c: Crumb[]) => void = () => {};
export function useCrumbs(c: Crumb[]) {
  const key = JSON.stringify(c);
  useEffect(() => setCrumbsGlobal(JSON.parse(key)), [key]);
}

function lbl(t: string) {
  return (
    <span className="lbl" data-t={t}>
      <span>{t}</span>
    </span>
  );
}

export function Shell() {
  const app = useApp();
  const [crumbs, setCrumbs] = useState<Crumb[]>([]);
  setCrumbsGlobal = setCrumbs;
  const [rail, setRail] = useState(() => {
    try {
      return localStorage.getItem("iwui.rail") === "1";
    } catch {
      return false;
    }
  });
  const [navOpen, setNavOpen] = useState(false);
  const [cmdk, setCmdk] = useState(false);
  const loc = useLocation();
  useEffect(() => setNavOpen(false), [loc.pathname]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdk((o) => !o);
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);

  const toggleRail = () => {
    setRail((r) => {
      try {
        localStorage.setItem("iwui.rail", r ? "0" : "1");
      } catch {
        /* ignore */
      }
      return !r;
    });
  };

  return (
    <div className={"app" + (navOpen ? " nav-open" : "")}>
      <Sidebar rail={rail} toggleRail={toggleRail} />
      {navOpen && <div className="scrim on" style={{ zIndex: 44 }} onClick={() => setNavOpen(false)} />}
      <div className="main">
        <header className="top">
          <button className="btn btn-q ib menu-btn press" aria-label="Open navigation" onClick={() => setNavOpen(true)}>
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
              <path d="M3 5h12M3 9h12M3 13h12" />
            </svg>
          </button>
          <nav className="crumbs" aria-label="Breadcrumb">
            {crumbs.map((c, i) => (
              <Fragment key={i}>
                {i > 0 && <span>/</span>}
                {c.to && i < crumbs.length - 1 ? (
                  <Link to={c.to} style={{ textDecoration: "none" }}>
                    <button tabIndex={-1}>{c.label}</button>
                  </Link>
                ) : (
                  <b>{c.label}</b>
                )}
              </Fragment>
            ))}
          </nav>
          <div className="top-r">
            <Fresh />
            <Tasks />
            <ModeBtn />
            <button className="kbtn press" onClick={() => setCmdk(true)} aria-label="Search or run a command">
              {ic.search}
              <span className="lbl2">Search or run a command</span>
              <span className="kbd">
                <kbd>{navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}</kbd>
                <kbd>K</kbd>
              </span>
            </button>
          </div>
        </header>
        <main className="page view-in" key={loc.pathname.split("/").slice(0, 2).join("/")}>
          {app.serversLoaded && app.servers.length === 0 && !loc.pathname.startsWith("/settings") ? <NoServers /> : <Outlet />}
        </main>
      </div>
      <CmdK open={cmdk} onClose={() => setCmdk(false)} />
      <ConfirmHost />
      <StopHost />
    </div>
  );
}

function NoServers() {
  useCrumbs([{ label: "Welcome" }]);
  return (
    <div className="panel" style={{ padding: 24, maxWidth: 640 }}>
      <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>Connect your first server</h1>
      <p className="dim2" style={{ margin: "0 0 16px" }}>
        On the Incus server, run <span className="mono">incus config trust add incus-webui</span> and paste the token it prints in Settings, Servers.
      </p>
      <Link to="/settings/servers" className="btn btn-p press" style={{ textDecoration: "none" }}>
        Add a server
      </Link>
    </div>
  );
}

function Fresh() {
  const { lastUpdate, tasks } = useApp();
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.round((Date.now() - lastUpdate) / 1000));
  return (
    <div className={"fresh" + (tasks.length ? " busy" : "")} aria-live="off">
      <i />
      <span>{s < 3 ? "Updated just now" : s < 60 ? `Updated ${s} s ago` : `Updated ${Math.floor(s / 60)} min ago`}</span>
    </div>
  );
}

export type Job = { id: string; kind: string; title: string; user?: string; mine?: boolean; state: "running" | "done" | "failed" | "cancelled"; progress: number; detail?: string; error?: string; link?: string; note?: string; started: string; ended?: string };

// Jobs run in the backend (backups, imports) and outlive the browser tab.
// The top bar needs only what runs now and the latest few (recent); the
// Tasks page loads the whole history.
export function useJobs(all = false) {
  const [fast, setFast] = useState(false);
  const q = useData<Job[]>(all ? "ui-jobs-all" : "ui-jobs", () => ui(all ? "/jobs" : "/jobs?recent=8"), fast ? 2000 : 15000);
  const running = (q.data || []).some((j) => j.state === "running");
  useEffect(() => setFast(running), [running]);
  return q;
}

// The Tasks button always sits in the top bar, so people know where to look,
// even when nothing ran yet. The tray shows what runs now and the latest
// finished tasks; the Tasks page has the full 30-day history.
function Tasks() {
  const { tasks } = useApp();
  const jobs = useJobs().data || [];
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOutside(ref, () => setOpen(false), open);
  const running = jobs.filter((j) => j.state === "running");
  const recent = jobs.filter((j) => j.state !== "running");
  const busy = tasks.length + running.length;
  const close = () => setOpen(false);
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button className="opsbtn press" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={busy > 0 ? `Tasks, ${busy} running` : "Tasks"}>
        {busy > 0 ? (
          <svg className="ring spin" viewBox="0 0 16 16" aria-hidden="true">
            <circle className="t" cx="8" cy="8" r="6" />
            <circle className="v" cx="8" cy="8" r="6" strokeDasharray="37.7" strokeDashoffset="26" />
          </svg>
        ) : (
          <span className="ops-ic" aria-hidden="true">{ic.tasks}</span>
        )}
        <span className="lbl2">{busy > 0 ? `${busy} running` : "Tasks"}</span>
      </button>
      {open && (
        <div className="tray">
          {busy > 0 && <h3>Running</h3>}
          {tasks.map((t) => (
            <div className="op" key={t.id}>
              <span>{t.label}</span>
              <small>{t.detail || "working"}</small>
            </div>
          ))}
          {running.map((j) => (
            <JobRow key={j.id} j={j} onOpen={close} />
          ))}
          {recent.length > 0 && <h3>Recent</h3>}
          {recent.map((j) => (
            <JobRow key={j.id} j={j} onOpen={close} />
          ))}
          {!busy && !recent.length && <p className="tray-empty">No tasks yet. Backups, imports and actions like starting an instance show up here, and stay for 30 days.</p>}
          <Link className="tray-all" to="/tasks" onClick={close}>
            All tasks
          </Link>
        </div>
      )}
    </div>
  );
}

export async function cancelJob(j: Job) {
  await ui(`/jobs/${j.id}`, { method: "DELETE" }).catch(() => {});
  invalidate("ui-jobs");
}

function JobRow({ j, onOpen }: { j: Job; onOpen: () => void }) {
  if (j.state === "running")
    return (
      <div className="op">
        <span>{j.title}</span>
        <div className="jbar" role="progressbar" aria-valuenow={Math.round(j.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
          <i style={{ transform: `scaleX(${Math.max(0.02, j.progress)})` }} />
        </div>
        <small>
          {j.detail || "working"}
          <button className="lnk" onClick={() => cancelJob(j)}>
            Cancel
          </button>
        </small>
      </div>
    );
  return (
    <div className="op">
      <span>{j.title}</span>
      <small className={j.state === "failed" ? "bad" : undefined}>
        <span className="op-res">{jobResult(j)}</span>
        {j.link && j.state === "done" ? (
          <Link className="lnk" to={j.link} onClick={onOpen}>
            Open
          </Link>
        ) : (
          <span className="op-when">{j.ended ? since(j.ended).replace(/^(\d.*)$/, "$1 ago") : ""}</span>
        )}
      </small>
    </div>
  );
}

export function jobResult(j: Job) {
  return j.state === "done" ? j.note || "Done" : j.state === "cancelled" ? "Cancelled" : j.state === "failed" ? j.error || "Failed" : j.detail || "working";
}

type NavItem = { to: string; label: string; icon?: ReactNode; end?: boolean; admin?: boolean };
type NavGroup = { key: string; label: string; icon: ReactNode; items: NavItem[] };
const groups: NavGroup[] = [
  {
    key: "net",
    label: "Networking",
    icon: ic.net,
    items: [
      { to: "/networks", label: "Networks", end: true },
      { to: "/networks/acls", label: "ACLs" },
      { to: "/networks/ipam", label: "IPAM" },
      { to: "/tunnels", label: "Tunnels", admin: true },
    ],
  },
  {
    key: "storage",
    label: "Storage",
    icon: ic.disk,
    items: [
      { to: "/storage", label: "Pools", end: true },
      { to: "/storage/volumes", label: "Volumes" },
      { to: "/storage/buckets", label: "Buckets" },
      { to: "/storage/isos", label: "Custom ISOs" },
    ],
  },
];

function useOpenGroups() {
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem("iwui.groups") || "{}");
    } catch {
      return {};
    }
  });
  const toggle = (k: string, v?: boolean) =>
    setOpen((o) => {
      const n = { ...o, [k]: v ?? !(o[k] ?? true) };
      try {
        localStorage.setItem("iwui.groups", JSON.stringify(n));
      } catch {
        /* ignore */
      }
      return n;
    });
  return [open, toggle] as const;
}

function Group({ g, open, toggle, rail }: { g: NavGroup; open: boolean; toggle: () => void; rail: boolean }) {
  const loc = useLocation();
  const nav = useNavigate();
  const { admin } = useApp();
  g = { ...g, items: g.items.filter((i) => admin || !i.admin) };
  const inside = g.items.some((i) => (i.end ? loc.pathname === i.to : loc.pathname.startsWith(i.to)));
  return (
    <>
      <button
        className="ni ngrp"
        title={g.label}
        aria-expanded={open}
        aria-current={inside && (rail || !open) ? "page" : undefined}
        onClick={() => (rail ? nav(g.items[0].to) : toggle())}
      >
        {g.icon}
        {lbl(g.label)}
        <span className="chev2">{ic.down}</span>
      </button>
      <div className={"nsub" + (open ? "" : " shut")}>
        <div className="sub">
          {g.items.map((i) => (
            <NavLink key={i.to} to={i.to} end={i.end} className="ni" tabIndex={open ? undefined : -1}>
              <span className="lbl-t">{i.label}</span>
            </NavLink>
          ))}
        </div>
      </div>
    </>
  );
}

function Sidebar({ rail, toggleRail }: { rail: boolean; toggleRail: () => void }) {
  const app = useApp();
  const { data: rows } = useInstances();
  const loc = useLocation();
  const online = app.servers.filter((s) => s.online && s.trusted).length;
  const upd = useData<{ newer?: boolean }>("ui-update", () => ui("/update"));
  const warnings = useWarningCount();
  const busy = app.tasks.length + (useJobs().data || []).filter((j) => j.state === "running").length;
  // Hide pins of instances that are gone; pins in other projects stay.
  const inScope = (p: { project: string }) => app.project === "*" || app.project === p.project;
  const pinned = usePins().filter((p) => app.servers.some((s) => s.name === p.server) && (!rows || !inScope(p) || rows.some((r) => r.server === p.server && r.name === p.name)));
  const stateOf = (r: { server: string; name: string }) => rows?.find((x) => x.server === r.server && x.name === r.name)?.status || "";
  const [openG, toggleG] = useOpenGroups();
  // The menu scrolls between the scope picker and the footer; a fade hints at more below.
  const navRef = useRef<HTMLElement>(null);
  const [more, setMore] = useState(false);
  useEffect(() => {
    const el = navRef.current;
    if (!el) return;
    const f = () => setMore(el.scrollHeight - el.scrollTop - el.clientHeight > 4);
    f();
    el.addEventListener("scroll", f, { passive: true });
    const ro = new ResizeObserver(f);
    ro.observe(el);
    for (const c of Array.from(el.children)) ro.observe(c);
    return () => (el.removeEventListener("scroll", f), ro.disconnect());
  });

  return (
    <aside className={"side" + (rail ? " rail" : "")} aria-label="Sidebar">
      <div className="side-top">
        <Mark />
        <span className="brand">Incus</span>
        <button className="collapse" onClick={toggleRail} aria-label={rail ? "Expand sidebar" : "Collapse sidebar"}>
          {ic.side}
        </button>
      </div>
      <Scope online={online} />
      <div className={"nav-wrap" + (more ? " more" : "")}>
      <nav className="nav" ref={navRef}>
        <NavLink to="/" end className="ni" title="Overview">
          {ic.home}
          {lbl("Overview")}
        </NavLink>
        <NavLink to="/instances" end className="ni" title="Instances" aria-current={loc.pathname.startsWith("/instances") ? "page" : undefined}>
          {ic.inst}
          {lbl("Instances")}
          <span className="count">{rows?.length ?? ""}</span>
        </NavLink>
        {pinned.length > 0 && (
          <div className="sub">
            {pinned.map((r) => (
              <NavLink key={r.server + r.project + r.name} to={`/instances/${r.server}/${r.name}?project=${encodeURIComponent(r.project)}`} className="ni" title={r.name}>
                <span className="st-dot" data-s={stateOf(r)} />
                <span className="lbl-t">{r.name}</span>
              </NavLink>
            ))}
          </div>
        )}
        <NavLink to="/profiles" className="ni" title="Profiles">
          {ic.prof}
          {lbl("Profiles")}
        </NavLink>
        {groups.map((g) => (
          <Group key={g.key} g={g} open={openG[g.key] ?? true} toggle={() => toggleG(g.key)} rail={rail} />
        ))}
        <NavLink to="/images" className="ni" title="Images">
          {ic.img}
          {lbl("Images")}
        </NavLink>
        <NavLink to="/projects" className="ni" title="Projects">
          {ic.folder}
          {lbl("Projects")}
        </NavLink>
        {app.servers.length > 0 && <div className="grp">Hosts</div>}
        {app.servers.map((s) => (
          <NavLink key={s.name} to={`/hosts/${s.name}`} className="ni" title={s.name}>
            {ic.host}
            {lbl(s.name)}
            {!(s.online && s.trusted) && <span className="badge-dot" />}
          </NavLink>
        ))}
        <div className="grp">Activity</div>
        <NavLink to="/tasks" className="ni" title="Tasks">
          {ic.tasks}
          {lbl("Tasks")}
          {busy > 0 && <span className="count">{busy}</span>}
        </NavLink>
        <NavLink to="/operations" className="ni" title="Incus operations">
          {ic.pulse}
          {lbl("Operations")}
        </NavLink>
        <NavLink to="/warnings" className="ni" title="Warnings">
          {ic.warn}
          {lbl("Warnings")}
          {warnings.n > 0 && <span className={"count" + (warnings.hot ? " warn" : "")}>{warnings.n}</span>}
        </NavLink>
        {app.admin && (
          <NavLink to="/audit" className="ni" title="Audit log">
            {ic.shield}
            {lbl("Audit log")}
          </NavLink>
        )}
      </nav>
      </div>
      <div className="side-foot">
        <NavLink to="/settings" className="ni" title="Settings">
          {ic.gear}
          {lbl("Settings")}
          {upd.data?.newer && <span className="badge-dot upd" title="Update available" />}
        </NavLink>
        <Account />
      </div>
    </aside>
  );
}

// ModeBtn cycles Auto -> Light -> Dark. Settings > Appearance has the same choice.
function ModeBtn() {
  const app = useApp();
  const order: Mode[] = ["auto", "light", "dark"];
  const next = order[(order.indexOf(app.mode) + 1) % order.length];
  const name = (m: Mode) => m[0].toUpperCase() + m.slice(1);
  return (
    <button className="btn btn-q ib press" onClick={() => app.setMode(next)} aria-label={`Colour mode: ${name(app.mode)}. Switch to ${name(next)}`} title={`Colour mode: ${name(app.mode)}`}>
      {app.mode === "light" ? ic.sun : app.mode === "dark" ? ic.moon : ic.auto}
    </button>
  );
}

// New warnings across the servers in scope, for the sidebar badge.
function useWarningCount() {
  const servers = useScopedServers();
  const names = servers.map((s) => s.name).join(",");
  const q = useData<{ n: number; hot: boolean }>(
    names ? `warnings-count:${names}` : null,
    async () => {
      const all = await Promise.all(servers.map((s) => incus<any[]>(s.name, "/1.0/warnings?recursion=1").catch(() => [])));
      const fresh = all.flat().filter((w) => w.status === "new");
      return { n: fresh.length, hot: fresh.some((w) => w.severity === "moderate" || w.severity === "high") };
    },
    60000,
  );
  return q.data || { n: 0, hot: false };
}

function Account() {
  const { user, method } = useApp();
  const initials = user.replace(/@.*/, "").split(/[._\s-]+/).map((p) => p[0]).join("").slice(0, 2).toUpperCase();
  return (
    <div className="acct">
      <span className="av">{initials}</span>
      <span className="acct-txt">
        {user}
        <small>
          Signed in with {method === "oidc" ? <span className="ac">SSO</span> : "password"}
        </small>
      </span>
      <button
        className="collapse slop"
        aria-label="Sign out"
        title="Sign out"
        onClick={async () => {
          await ui("/logout", { method: "POST" });
          location.href = "/";
        }}
      >
        {ic.out}
      </button>
    </div>
  );
}

function Scope({ online }: { online: number }) {
  const app = useApp();
  const projects = useProjects();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOutside(ref, () => setOpen(false), open);
  const label = app.scope === "*" ? "All servers" : app.scope;
  const proj = app.project === "*" ? "all projects" : app.project;
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button className="scope press" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="health">
          {app.servers.slice(0, 4).map((s) => (
            <i key={s.name} className={s.online && s.trusted ? "" : "off"} />
          ))}
        </span>
        <span className="scope-txt">
          <b>{label}</b>
          <span>
            {app.scope === "*" ? `${online} of ${app.servers.length} online · ` : ""}
            {proj}
          </span>
        </span>
        <span className="chev">{ic.chev}</span>
      </button>
      {open && (
        <div className="menu" style={{ left: 0, right: 0, top: 46 }}>
          <button onClick={() => (app.setScope("*"), setOpen(false))}>
            All servers{app.scope === "*" && <span className="kbd">✓</span>}
          </button>
          {app.servers.map((s) => (
            <button key={s.name} onClick={() => (app.setScope(s.name), setOpen(false))} disabled={!(s.online && s.trusted)}>
              <span className={"st " + (s.online && s.trusted ? "running" : "error")} />
              {s.name}
              {app.scope === s.name && <span className="kbd">✓</span>}
            </button>
          ))}
          <hr />
          <div className="cmdk-g">Project</div>
          <button onClick={() => (app.setProject("*"), setOpen(false))}>
            All projects{app.project === "*" && <span className="kbd">✓</span>}
          </button>
          {(projects.data || ["default"]).map((p) => (
            <button key={p} onClick={() => (app.setProject(p), setOpen(false))}>
              {p}
              {app.project === p && <span className="kbd">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- command menu ----------
type Cmd = { group: string; label: string; meta?: string; icon: ReactNode; run: () => void };
type Found = { instances: { name: string; project: string; status: string; type: string; server: string }[]; things: { kind: string; name: string; server: string; project?: string; to: string }[] };

// One fetch per server for everything the menu can find, across all projects.
// Cached by useData, so reopening is instant and refreshes in the background.
async function loadFound(servers: string[]): Promise<Found> {
  const out: Found = { instances: [], things: [] };
  const list = (s: string, path: string) => incus<any[]>(s, path).catch(() => [] as any[]);
  await Promise.all(
    servers.map(async (s) => {
      const [inst, nets, pools, vols, profs, imgs, projs] = await Promise.all([
        list(s, "/1.0/instances?recursion=1&all-projects=true"),
        list(s, "/1.0/networks?recursion=1&all-projects=true"),
        list(s, "/1.0/storage-pools?recursion=1"),
        list(s, "/1.0/storage-volumes?recursion=1&all-projects=true"),
        list(s, "/1.0/profiles?recursion=1&all-projects=true"),
        list(s, "/1.0/images?recursion=1&all-projects=true"),
        list(s, "/1.0/projects?recursion=1"),
      ]);
      for (const i of inst) out.instances.push({ name: i.name, project: i.project || "default", status: i.status, type: i.type, server: s });
      for (const n of nets) if (n.managed) out.things.push({ kind: "Networks", name: n.name, server: s, project: n.project, to: "/networks" });
      for (const p of pools) out.things.push({ kind: "Storage pools", name: p.name, server: s, to: "/storage" });
      for (const v of vols) if (v.type === "custom") out.things.push({ kind: "Volumes", name: v.name, server: s, project: v.project, to: "/storage/volumes" });
      for (const p of profs) out.things.push({ kind: "Profiles", name: p.name, server: s, project: p.project, to: "/profiles" });
      for (const m of imgs) out.things.push({ kind: "Images", name: m.properties?.description || m.aliases?.[0]?.name || String(m.fingerprint).slice(0, 12), server: s, project: m.project, to: "/images" });
      for (const p of projs) out.things.push({ kind: "Projects", name: p.name, server: s, to: "/projects" });
    }),
  );
  out.instances.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

const groupOrder = ["Instances", "Instance actions", "Go to", "Actions", "Networks", "Storage pools", "Volumes", "Profiles", "Images", "Projects"];
const idleOrder = ["Go to", "Actions", "Instances"];
const groupIcon: Record<string, ReactNode> = { Networks: ic.net, "Storage pools": ic.disk, Volumes: ic.disk, Profiles: ic.prof, Images: ic.img, Projects: ic.folder };

function CmdK({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const app = useApp();
  const servers = useScopedServers();
  const names = servers.map((s) => s.name).join(",");
  const found = useData<Found>(open && names ? `cmdk:${names}` : null, () => loadFound(names.split(",")));
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) {
      setQ("");
      setSel(0);
    }
  }, [open]);
  const go = (to: string) => () => (nav(to), onClose());
  const multi = app.servers.length > 1;
  const cmds: Cmd[] = useMemo(() => {
    const list: Cmd[] = [
      { group: "Go to", label: "Overview", icon: ic.home, run: go("/") },
      { group: "Go to", label: "Instances", icon: ic.inst, run: go("/instances") },
      { group: "Go to", label: "Images", icon: ic.img, run: go("/images") },
      { group: "Go to", label: "Profiles", icon: ic.prof, run: go("/profiles") },
      { group: "Go to", label: "Networks", icon: ic.net, run: go("/networks") },
      { group: "Go to", label: "Network ACLs", icon: ic.shield, run: go("/networks/acls") },
      { group: "Go to", label: "IPAM, addresses in use", icon: ic.net, run: go("/networks/ipam") },
      { group: "Go to", label: "Storage pools", icon: ic.disk, run: go("/storage") },
      { group: "Go to", label: "Storage volumes", icon: ic.disk, run: go("/storage/volumes") },
      { group: "Go to", label: "Buckets", icon: ic.disk, run: go("/storage/buckets") },
      { group: "Go to", label: "Custom ISOs", icon: ic.disk, run: go("/storage/isos") },
      { group: "Go to", label: "Projects", icon: ic.folder, run: go("/projects") },
      { group: "Go to", label: "Tasks", icon: ic.tasks, run: go("/tasks") },
      { group: "Go to", label: "Operations", icon: ic.pulse, run: go("/operations") },
      { group: "Go to", label: "Warnings", icon: ic.warn, run: go("/warnings") },
      { group: "Go to", label: "Settings", icon: ic.gear, run: go("/settings") },
      ...app.servers.map((s) => ({ group: "Go to", label: `Host ${s.name}`, icon: ic.host, run: go(`/hosts/${s.name}`) })),
      { group: "Actions", label: "Create instance", icon: ic.plus, run: go("/instances?create=1") },
      { group: "Actions", label: "Pull image", icon: ic.dl, run: go("/images") },
      { group: "Actions", label: "Add server", icon: ic.host, run: go("/settings/servers") },
      { group: "Actions", label: "Switch to dark mode", icon: ic.screen, run: () => (app.setMode("dark"), onClose()) },
      { group: "Actions", label: "Switch to light mode", icon: ic.screen, run: () => (app.setMode("light"), onClose()) },
    ];
    const where = (project: string | undefined, server: string, always = false) => [project && (always || project !== "default") ? project : "", multi ? server : ""].filter(Boolean).join(" · ");
    for (const r of found.data?.instances || []) {
      const base = `/instances/${r.server}/${encodeURIComponent(r.name)}`;
      const pq = `?project=${encodeURIComponent(r.project)}`;
      const on = r.status === "Running";
      const place = where(r.project, r.server, true);
      const stop = async () => {
        onClose();
        const ans = await askStop([r]);
        if (ans) power("stop", "Stopping", ans.force)();
      };
      const power = (action: "start" | "stop" | "restart" | "unfreeze", verb: string, force = false) => () => {
        onClose();
        app.run(`${verb} ${r.name}`, () =>
          incusOp(r.server, `/1.0/instances/${encodeURIComponent(r.name)}/state`, { method: "PUT", project: r.project, body: { action, timeout: 30, force } }).finally(() => {
            invalidate("instances:");
            invalidate(`instance:${r.server}:${r.name}`);
            invalidate("cmdk:");
            app.touch();
          }),
        );
      };
      list.push({ group: "Instances", label: r.name, meta: `${r.status} · ${place}`, icon: r.type === "virtual-machine" ? ic.vm : ic.ct, run: go(base + pq) });
      if (canDo("start", r.status)) list.push({ group: "Instance actions", label: `Start ${r.name}`, meta: place, icon: ic.play, run: power("start", "Starting") });
      if (canDo("unfreeze", r.status)) list.push({ group: "Instance actions", label: `Resume ${r.name}`, meta: place, icon: ic.play, run: power("unfreeze", "Resuming") });
      if (canDo("stop", r.status)) list.push({ group: "Instance actions", label: `${on ? "Stop" : "Force stop"} ${r.name}`, meta: place, icon: ic.stop, run: stop });
      if (canDo("restart", r.status)) list.push({ group: "Instance actions", label: `Restart ${r.name}`, meta: place, icon: ic.restart, run: power("restart", "Restarting") });
      if (on) list.push({ group: "Instance actions", label: `Open terminal in ${r.name}`, meta: place, icon: ic.term, run: go(base + "/terminal" + pq) });
    }
    for (const t of found.data?.things || []) list.push({ group: t.kind, label: t.name, meta: where(t.project, t.server), icon: groupIcon[t.kind], run: go(t.to) });
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [found.data, app.servers, multi]);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = useMemo(() => {
    const idle = !words.length;
    // Without a search, keep the menu short: pages, actions and instances.
    const hit = cmds.filter((c) => (idle ? idleOrder.includes(c.group) : words.every((w) => (c.label + " " + c.group + " " + (c.meta || "")).toLowerCase().includes(w))));
    // A query that starts like an action ("stop", "restart") puts actions above instances whose state text matches.
    const verb = !idle && hit.some((c) => c.group === "Instance actions" && c.label.toLowerCase().startsWith(words[0]));
    const order = idle ? idleOrder : verb ? ["Instance actions", ...groupOrder.filter((g) => g !== "Instance actions")] : groupOrder;
    const score = (c: Cmd) => (idle || c.label.toLowerCase().startsWith(words[0]) ? 0 : 1);
    return hit
      .map((c, i) => ({ c, i }))
      .sort((a, b) => order.indexOf(a.c.group) - order.indexOf(b.c.group) || score(a.c) - score(b.c) || a.i - b.i)
      .map((x) => x.c)
      .slice(0, 80);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cmds, q]);
  // Keep the selected row in view when moving with the arrow keys.
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [sel, shown]);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") (e.preventDefault(), setSel((s) => Math.min(s + 1, shown.length - 1)));
    if (e.key === "ArrowUp") (e.preventDefault(), setSel((s) => Math.max(s - 1, 0)));
    if (e.key === "Enter") shown[sel]?.run();
  };
  let lastGroup = "";
  return (
    <Dialog open={open} onClose={onClose}>
      <div className="cmdk-in">
        {ic.search}
        <input autoFocus placeholder="Search instances, networks, storage and more" value={q} onChange={(e) => (setQ(e.target.value), setSel(0))} onKeyDown={onKey} />
        <kbd>esc</kbd>
      </div>
      <div className="cmdk-list" role="listbox" ref={listRef}>
        {shown.map((c, i) => {
          const g = c.group !== lastGroup ? (lastGroup = c.group) : null;
          return (
            <Fragment key={c.group + c.label + (c.meta || "")}>
              {g && <div className="cmdk-g">{g}</div>}
              <button className="cmdk-i" aria-selected={i === sel} onMouseMove={() => sel !== i && setSel(i)} onClick={c.run}>
                {c.icon}
                <span className="cmdk-l">{c.label}</span>
                {c.meta && <span className="meta">{c.meta}</span>}
              </button>
            </Fragment>
          );
        })}
        {!shown.length && <div className="cmdk-g">{found.loading ? "Searching…" : `Nothing matches “${q}”.`}</div>}
      </div>
      <div className="cmdk-f">
        <span>
          <kbd>↑</kbd> <kbd>↓</kbd> to move
        </span>
        <span>
          <kbd>↵</kbd> to open
        </span>
      </div>
    </Dialog>
  );
}
