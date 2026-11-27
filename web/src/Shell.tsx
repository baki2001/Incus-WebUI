import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { dateTime, incus, since, ui } from "./api";
import { ic, Mark } from "./icons";
import { invalidate, lastFresh, useApp, useData, useScopedServers } from "./state";
import { ConfirmHost, Dialog, useOutside, usePresence, useShown, useThumb } from "./ui";
import { canDo } from "./pages/Instances";
import { askStop, StopHost } from "./pages/InstanceDialogs";
import { setState, usePins, useInstances, useProjects } from "./data";

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
  const { mounted: scrimMounted, on: scrimOn } = useShown(navOpen);
  const [cmdk, setCmdk] = useState(false);
  const loc = useLocation();
  useEffect(() => setNavOpen(false), [loc.pathname]);

  useEffect(() => {
    if (!navOpen) return;
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") setNavOpen(false);
    };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [navOpen]);

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
      {scrimMounted && <div className={"scrim" + (scrimOn ? " on" : "")} style={{ zIndex: 44 }} onClick={() => setNavOpen(false)} />}
      <div className="main">
        <header className="top">
          <button className="btn btn-q ib menu-btn press" aria-label="Open navigation" onClick={() => setNavOpen(true)}>
            {ic.menu}
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
  const { tasks } = useApp();
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  // The newest good load of what this page shows. Pages without live data show nothing.
  const at = lastFresh();
  if (!at) return null;
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  return (
    <div className={"fresh" + (tasks.length ? " busy" : "")} aria-live="off">
      <i />
      <span>{s < 3 ? "Updated just now" : s < 60 ? `Updated ${s} s ago` : s < 3600 ? `Updated ${Math.floor(s / 60)} min ago` : `Updated ${Math.floor(s / 3600)} h ago`}</span>
    </div>
  );
}

export type Job = { id: string; kind: string; title: string; user?: string; mine?: boolean; state: "running" | "done" | "failed" | "cancelled"; progress: number; detail?: string; error?: string; link?: string; note?: string; started: string; ended?: string };

// Jobs run in the backend (backups, imports) and outlive the browser tab.
// The top bar needs only what runs now and the latest few (recent); the
// Tasks page loads the whole history.
export function useJobs(all = false) {
  const [fast, setFast] = useState(false);
  const q = useData<Job[]>(all ? "ui-jobs-all" : "ui-jobs", () => ui(all ? "/jobs" : "/jobs?recent=8"), fast ? 2000 : 15000, !all);
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
  const { mounted, leaving } = usePresence(open);
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
      {mounted && (
        <div className={"tray" + (leaving ? " leaving" : "")}>
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
          {groupRepeats(recent).map(({ j, n }) => (
            <DoneRow key={j.id} j={j} n={n} onOpen={close} />
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
        <div className="prog" style={{ margin: "6px 0 4px" }} role="progressbar" aria-valuenow={Math.round(j.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
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
  return <DoneRow j={j} onOpen={onOpen} />;
}

// A finished task reads as one short sentence ("Deleted test-nieuw",
// "Couldn't delete test-nieuw") with the time on the right. A failure shows
// its whole error underneath; a long one opens on click.
function DoneRow({ j, n = 1, onOpen }: { j: Job; n?: number; onOpen: () => void }) {
  const [full, setFull] = useState(false);
  const t = taskText(j);
  const when = j.ended ? since(j.ended).replace(/^(\d.*)$/, "$1 ago") : "";
  return (
    <div className={"op op-done" + (j.state === "failed" ? " op-bad" : "")}>
      <div className="op-l1">
        <span className="op-what">
          {t.line}
          {n > 1 && <span className="op-n"> ×{n}</span>}
        </span>
        <span className="op-when" title={dateTime(j.ended || j.started)}>
          {when}
        </span>
      </div>
      {t.detail && (
        <button type="button" className={"op-detail" + (full ? " full" : "")} onClick={() => setFull(!full)} title={full ? undefined : t.detail}>
          {t.detail}
        </button>
      )}
      {j.link && j.state === "done" && (
        <Link className="lnk op-open" to={j.link} onClick={onOpen}>
          Open
        </Link>
      )}
    </div>
  );
}

// The same task can fail a few times in a row with the same error; show it once.
export function groupRepeats(list: Job[]) {
  const out: { j: Job; n: number }[] = [];
  for (const j of list) {
    const last = out[out.length - 1];
    if (last && last.j.title === j.title && last.j.state === j.state && (last.j.error || "") === (j.error || "")) last.n++;
    else out.push({ j, n: 1 });
  }
  return out;
}

// Labels are written while the task runs ("Deleting web"). Once it ended,
// say what happened instead.
const tenses: Record<string, [string, string]> = {
  Deleting: ["Deleted", "delete"], Saving: ["Saved", "save"], Creating: ["Created", "create"], Restoring: ["Restored", "restore"],
  Removing: ["Removed", "remove"], Starting: ["Started", "start"], Stopping: ["Stopped", "stop"], Restarting: ["Restarted", "restart"],
  Pausing: ["Paused", "pause"], Resuming: ["Resumed", "resume"], Pulling: ["Pulled", "pull"], Marking: ["Marked", "mark"],
  Cancelling: ["Cancelled", "cancel"], Attaching: ["Attached", "attach"], Adding: ["Added", "add"], Acknowledging: ["Acknowledged", "acknowledge"],
  Import: ["Imported", "import"], Restore: ["Restored", "restore"], "Back up": ["Backed up", "back up"],
};

export function taskText(j: Job): { line: string; detail?: string } {
  const m = Object.keys(tenses).find((v) => j.title === v || j.title.startsWith(v + " "));
  const rest = m ? j.title.slice(m.length) : "";
  if (j.state === "failed") return { line: m ? `Couldn't ${tenses[m][1]}${rest}` : `${j.title} failed`, detail: j.error || "No reason given." };
  if (j.state === "cancelled") return { line: j.title, detail: "Cancelled" };
  if (j.state === "running") return { line: j.title, detail: j.detail || "working" };
  const line = m ? tenses[m][0] + rest : j.title;
  if (!j.note || j.note === "Done") return { line };
  // The note is the message shown when it finished, like "Network web
  // deleted". When it says the same thing with more detail, it becomes the line.
  if (covers(j.note, line)) return { line: j.note };
  return { line, detail: j.note };
}

const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}._-]+/gu) || [];
function covers(note: string, line: string) {
  const n = new Set(words(note));
  return words(line).every((w) => n.has(w));
}

export function jobResult(j: Job) {
  return taskText(j).detail || "Done";
}

type NavItem = { to: string; label: string; icon?: ReactNode; end?: boolean; admin?: boolean; dot?: string };
type NavGroup = { key: string; label: string; icon: ReactNode; items: NavItem[]; alert?: boolean };
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

// Groups start closed. The group of the page you are on opens by itself,
// until you open or close it by hand; that choice is remembered.
function useOpenGroups() {
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem("iwui.nav") || "{}");
    } catch {
      return {};
    }
  });
  const set = (k: string, v: boolean) =>
    setOpen((o) => {
      const n = { ...o, [k]: v };
      try {
        localStorage.setItem("iwui.nav", JSON.stringify(n));
      } catch {
        /* ignore */
      }
      return n;
    });
  return [open, set] as const;
}

function Group({ g, stored, set, rail }: { g: NavGroup; stored?: boolean; set: (v: boolean) => void; rail: boolean }) {
  const loc = useLocation();
  const nav = useNavigate();
  const { admin } = useApp();
  g = { ...g, items: g.items.filter((i) => admin || !i.admin) };
  const inside = g.items.some((i) => (i.end ? loc.pathname === i.to : loc.pathname.startsWith(i.to)));
  const open = stored ?? inside;
  return (
    <>
      <button
        className="ni ngrp"
        title={g.label}
        aria-expanded={open}
        aria-current={inside && (rail || !open) ? "page" : undefined}
        onClick={() => (rail ? nav(g.items[0].to) : set(!open))}
      >
        {g.icon}
        {lbl(g.label)}
        {g.alert && !open && <span className="badge-dot" />}
        <span className="chev2">{ic.down}</span>
      </button>
      <div className={"nsub" + (open ? "" : " shut")}>
        <div className="sub">
          {g.items.map((i) => (
            <NavLink key={i.to} to={i.to} end={i.end} className="ni" tabIndex={open ? undefined : -1} title={i.label}>
              {i.dot !== undefined && <span className="st-dot" data-s={i.dot} />}
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
  const upd = useData<{ newer?: boolean }>("ui-update", () => ui("/update"), 0, true);
  const ver = useData<{ version: string }>("ui-version", () => ui("/version"), 0, true).data?.version;
  const warnings = useWarningCount();
  const busy = app.tasks.length + (useJobs().data || []).filter((j) => j.state === "running").length;
  // Hide pins of instances that are gone; pins in other projects stay.
  const inScope = (p: { project: string }) => app.project === "*" || app.project === p.project;
  const pinned = usePins().filter((p) => app.servers.some((s) => s.name === p.server) && (!rows || !inScope(p) || rows.some((r) => r.server === p.server && r.name === p.name)));
  const stateOf = (r: { server: string; name: string }) => rows?.find((x) => x.server === r.server && x.name === r.name)?.status || "";
  const [openG, setG] = useOpenGroups();
  // The menu scrolls between the scope picker and the footer; a fade hints at more below.
  const navRef = useRef<HTMLElement>(null);
  useThumb(navRef, '.ni.active, .ni[aria-current="page"]', [loc.pathname, rail, openG, pinned.length, app.servers.length]);
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
        {ver && isDevBuild(ver) && (
          <span className="dev-pill" title={`You are running a dev build (${showVersion(ver)})`}>
            Dev
          </span>
        )}
        <button className="collapse" onClick={toggleRail} aria-label={rail ? "Expand sidebar" : "Collapse sidebar"}>
          {ic.side}
        </button>
      </div>
      <Scope online={online} rail={rail} />
      <div className={"nav-wrap" + (more ? " more" : "")}>
      <nav className="nav" id="side-nav" ref={navRef}>
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
        <NavLink to="/images" className="ni" title="Images">
          {ic.img}
          {lbl("Images")}
        </NavLink>
        <NavLink to="/profiles" className="ni" title="Profiles">
          {ic.prof}
          {lbl("Profiles")}
        </NavLink>
        <div className="grp">Infrastructure</div>
        {app.servers.length === 1 ? (
          <NavLink to={`/hosts/${app.servers[0].name}`} className="ni" title={`Host ${app.servers[0].name}`}>
            {ic.host}
            {lbl("Hosts")}
            {!(app.servers[0].online && app.servers[0].trusted) && <span className="badge-dot" />}
          </NavLink>
        ) : (
          app.servers.length > 1 && (
            <Group
              g={{
                key: "hosts",
                label: "Hosts",
                icon: ic.host,
                alert: app.servers.some((s) => !(s.online && s.trusted)),
                items: app.servers.map((s) => ({ to: `/hosts/${s.name}`, label: s.name, dot: s.online && s.trusted ? "Running" : "Error" })),
              }}
              stored={openG.hosts}
              set={(v) => setG("hosts", v)}
              rail={rail}
            />
          )
        )}
        {groups.map((g) => (
          <Group key={g.key} g={g} stored={openG[g.key]} set={(v) => setG(g.key, v)} rail={rail} />
        ))}
        <NavLink to="/backups" className="ni" title="Backups">
          {ic.backup}
          {lbl("Backups")}
        </NavLink>
        <div className="grp">Activity</div>
        <NavLink to="/tasks" className={({ isActive }) => "ni" + (isActive || loc.pathname.startsWith("/operations") ? " active" : "")} title="Tasks">
          {ic.tasks}
          {lbl("Tasks")}
          {busy > 0 && <span className="count">{busy}</span>}
        </NavLink>
        <NavLink to="/warnings" className="ni" title="Warnings">
          {ic.warn}
          {lbl("Warnings")}
          {warnings.n > 0 && <span className={"count" + (warnings.hot ? " warn" : "")}>{warnings.n}</span>}
        </NavLink>
        {app.admin && (
          <NavLink to="/audit" className="ni" title="Audit log">
            {ic.log}
            {lbl("Audit log")}
          </NavLink>
        )}
      </nav>
      </div>
      <div className="side-foot">
        <Account rail={rail} version={ver} update={!!upd.data?.newer} />
      </div>
    </aside>
  );
}

// showVersion puts a "v" in front of numbered versions. Local builds report "dev".
export function showVersion(v: string) {
  return /^\d/.test(v) ? "v" + v : v;
}

// isDevBuild is true for dev and prerelease builds, like v0.7.2-dev.2 or v0.8.0-beta.1.
export function isDevBuild(v: string) {
  return v === "dev" || v.includes("-");
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
    true,
  );
  return q.data || { n: 0, hot: false };
}

// Account is the signed-in user at the bottom of the sidebar. It opens a menu
// with settings, updates and sign out.
function Account({ rail, version, update }: { rail: boolean; version?: string; update: boolean }) {
  const { user, method } = useApp();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<CSSProperties>({});
  const { mounted, leaving } = usePresence(open);
  const ref = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  useOutside(ref, () => setOpen(false), open);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        btn.current?.focus();
      }
    };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [open]);
  const toggle = () => {
    const r = btn.current?.getBoundingClientRect();
    if (r) {
      // Fixed, so the collapsed sidebar doesn't clip it.
      setPos(
        rail
          ? { left: r.right + 8, bottom: window.innerHeight - r.bottom, minWidth: 220 }
          : { left: r.left, bottom: window.innerHeight - r.top + 6, width: Math.max(r.width, 220) },
      );
    }
    setOpen(!open);
  };
  const go = (to: string) => {
    setOpen(false);
    nav(to);
  };
  const initials = user.replace(/@.*/, "").split(/[._\s-]+/).map((p) => p[0]).join("").slice(0, 2).toUpperCase();
  return (
    <div ref={ref}>
      <button ref={btn} className="acct press" onClick={toggle} aria-haspopup="menu" aria-expanded={open} title={rail ? user : undefined}>
        <span className="av">
          {initials}
          {update && <span className="av-dot" title="Update available" />}
        </span>
        <span className="acct-txt">
          {user}
          {version && <small>{showVersion(version)}</small>}
        </span>
        <span className="chev">{ic.chev}</span>
      </button>
      {mounted && (
        <div className={"menu acct-menu" + (leaving ? " leaving" : "")} role="menu" style={pos}>
          <button role="menuitem" autoFocus onClick={() => go("/settings")}>
            {ic.gear}
            Settings
          </button>
          {method === "password" && (
            <button role="menuitem" onClick={() => go("/settings/security")}>
              {ic.shield}
              Sign-in security
            </button>
          )}
          <button role="menuitem" onClick={() => go("/settings/about")}>
            {ic.dl}
            Updates and about
            {update && <span className="badge-dot upd" title="Update available" />}
          </button>
          <hr />
          <button
            role="menuitem"
            onClick={async () => {
              await ui("/logout", { method: "POST" });
              location.href = "/";
            }}
          >
            {ic.out}
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

// Scope picks the server and project. In the collapsed sidebar the menu opens
// to the right of the button, like the account menu.
function Scope({ online, rail }: { online: number; rail: boolean }) {
  const app = useApp();
  const nav = useNavigate();
  const projects = useProjects();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<CSSProperties>({ left: 0, right: 0, top: 46 });
  const { mounted, leaving } = usePresence(open);
  const ref = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  useOutside(ref, () => setOpen(false), open);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        btn.current?.focus();
      }
    };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [open]);
  // Close it when the sidebar changes width, so it never sits in the wrong place.
  useEffect(() => setOpen(false), [rail]);
  const toggle = () => {
    const r = btn.current?.getBoundingClientRect();
    // Fixed in the collapsed sidebar, so the narrow sidebar doesn't clip it.
    setPos(
      rail && r
        ? { position: "fixed", left: r.right + 8, top: r.top, right: "auto", minWidth: 220, maxHeight: window.innerHeight - r.top - 12 }
        : { left: 0, right: 0, top: 46 },
    );
    setOpen(!open);
  };
  const label = app.scope === "*" ? "All servers" : app.scope;
  const proj = app.project === "*" ? "all projects" : app.project;
  const down = app.servers.some((s) => !(s.online && s.trusted));
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        ref={btn}
        className="scope press"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={rail ? `${label}, ${proj}` : undefined}
        title={rail ? `${label} · ${proj}` : undefined}
      >
        <span className="health">
          {app.servers.slice(0, 4).map((s) => (
            <i key={s.name} className={s.online && s.trusted ? "" : "off"} />
          ))}
        </span>
        <span className="scope-ic">
          {label.slice(0, 1).toUpperCase()}
          <i className={down ? "off" : ""} />
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
      {mounted && (
        <div className={"menu scope-menu" + (rail ? " side-pop" : "") + (leaving ? " leaving" : "")} style={pos}>
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
          <hr />
          <button onClick={() => (nav("/projects"), setOpen(false))}>
            {ic.proj}
            Manage projects
          </button>
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
const groupIcon: Record<string, ReactNode> = { Networks: ic.net, "Storage pools": ic.disk, Volumes: ic.volume, Profiles: ic.prof, Images: ic.img, Projects: ic.proj };

function CmdK({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const app = useApp();
  const servers = useScopedServers();
  const names = servers.map((s) => s.name).join(",");
  const found = useData<Found>(open && names ? `cmdk:${names}` : null, () => loadFound(names.split(",")), 0, true);
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
      { group: "Go to", label: "Profiles", icon: ic.prof, run: go("/profiles") },
      { group: "Go to", label: "Networks", icon: ic.net, run: go("/networks") },
      { group: "Go to", label: "ACLs", icon: ic.acl, run: go("/networks/acls") },
      { group: "Go to", label: "IPAM", icon: ic.ipam, run: go("/networks/ipam") },
      ...(app.admin ? [{ group: "Go to", label: "Tunnels", icon: ic.tunnel, run: go("/tunnels") }] : []),
      { group: "Go to", label: "Pools", icon: ic.disk, run: go("/storage") },
      { group: "Go to", label: "Volumes", icon: ic.volume, run: go("/storage/volumes") },
      { group: "Go to", label: "Buckets", icon: ic.bucket, run: go("/storage/buckets") },
      { group: "Go to", label: "Custom ISOs", icon: ic.iso, run: go("/storage/isos") },
      { group: "Go to", label: "Images", icon: ic.img, run: go("/images") },
      { group: "Go to", label: "Projects", icon: ic.proj, run: go("/projects") },
      { group: "Go to", label: "Backups", icon: ic.backup, run: go("/backups") },
      ...app.servers.map((s) => ({ group: "Go to", label: `Host ${s.name}`, icon: ic.host, run: go(`/hosts/${s.name}`) })),
      { group: "Go to", label: "Tasks", icon: ic.tasks, run: go("/tasks") },
      { group: "Go to", label: "Operations", icon: ic.pulse, run: go("/operations") },
      { group: "Go to", label: "Warnings", icon: ic.warn, run: go("/warnings") },
      ...(app.admin ? [{ group: "Go to", label: "Audit log", icon: ic.log, run: go("/audit") }] : []),
      { group: "Go to", label: "Settings", icon: ic.gear, run: go("/settings") },
      { group: "Actions", label: "Create instance", icon: ic.plus, run: go("/instances?create=1") },
      { group: "Actions", label: "Pull image", icon: ic.dl, run: go("/images") },
      { group: "Actions", label: "Add server", icon: ic.host, run: go("/settings/servers") },
      { group: "Actions", label: "Switch theme to Indigo", icon: ic.screen, run: () => (app.setMode("indigo"), onClose()) },
      { group: "Actions", label: "Switch theme to Porcelain", icon: ic.screen, run: () => (app.setMode("porcelain"), onClose()) },
      { group: "Actions", label: "Switch theme to Graphite", icon: ic.screen, run: () => (app.setMode("graphite"), onClose()) },
      { group: "Actions", label: "Switch theme to Graphite Ember", icon: ic.screen, run: () => (app.setMode("ember"), onClose()) },
      { group: "Actions", label: "Switch theme to Terracotta", icon: ic.screen, run: () => (app.setMode("terracotta"), onClose()) },
      { group: "Actions", label: "Switch theme to Custom", icon: ic.screen, run: () => (app.setMode("custom"), onClose()) },
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
          setState(r.server, r.project, r.name, { action, timeout: 30, force }).finally(() => {
            invalidate("instances:");
            invalidate(`instance:${r.server}:${r.name}`);
            invalidate("cmdk:");
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
  }, [found.data, app.servers, app.admin, multi]);
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
