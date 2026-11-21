import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { incus, ui } from "./api";
import { ic, Mark } from "./icons";
import { useApp, useData, useScopedServers, type Mode } from "./state";
import { ConfirmHost, Dialog, useOutside, useThumb } from "./ui";
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

function Tasks() {
  const { tasks } = useApp();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOutside(ref, () => setOpen(false), open);
  if (!tasks.length) return null;
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button className="opsbtn press" onClick={() => setOpen(!open)} aria-expanded={open}>
        <svg className="ring spin" viewBox="0 0 16 16">
          <circle className="t" cx="8" cy="8" r="6" />
          <circle className="v" cx="8" cy="8" r="6" strokeDasharray="37.7" strokeDashoffset="26" />
        </svg>
        {tasks.length} task{tasks.length > 1 ? "s" : ""}
      </button>
      {open && (
        <div className="tray">
          <h3>Running</h3>
          {tasks.map((t) => (
            <div className="op" key={t.id}>
              <span>{t.label}</span>
              <small>{t.detail || "working"}</small>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

type NavItem = { to: string; label: string; icon?: ReactNode; end?: boolean };
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
      { to: "/tunnels", label: "Tunnels" },
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
  // Hide pins of instances that are gone; pins in other projects stay.
  const inScope = (p: { project: string }) => app.project === "*" || app.project === p.project;
  const pinned = usePins().filter((p) => app.servers.some((s) => s.name === p.server) && (!rows || !inScope(p) || rows.some((r) => r.server === p.server && r.name === p.name)));
  const stateOf = (r: { server: string; name: string }) => rows?.find((x) => x.server === r.server && x.name === r.name)?.status || "";
  const modes: Mode[] = ["auto", "light", "dark"];
  const [openG, toggleG] = useOpenGroups();
  const seg = useRef<HTMLDivElement>(null);
  useThumb(seg, 'button[aria-pressed="true"]', [app.mode, rail]);

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
      <nav className="nav">
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
        <NavLink to="/operations" className="ni" title="Operations">
          {ic.pulse}
          {lbl("Operations")}
          {app.tasks.length > 0 && <span className="count">{app.tasks.length}</span>}
        </NavLink>
        <NavLink to="/warnings" className="ni" title="Warnings">
          {ic.warn}
          {lbl("Warnings")}
          {warnings > 0 && <span className="count warn">{warnings}</span>}
        </NavLink>
      </nav>
      <div className="side-foot">
        <NavLink to="/settings" className="ni" title="Settings">
          {ic.gear}
          {lbl("Settings")}
          {upd.data?.newer && <span className="badge-dot upd" title="Update available" />}
        </NavLink>
        <div className="theme-seg" role="group" aria-label="Colour mode" ref={seg}>
          {modes.map((m) => (
            <button key={m} aria-pressed={app.mode === m} onClick={() => app.setMode(m)}>
              {m[0].toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>
        <Account />
      </div>
    </aside>
  );
}

// New warnings across the servers in scope, for the sidebar badge.
function useWarningCount() {
  const servers = useScopedServers();
  const names = servers.map((s) => s.name).join(",");
  const q = useData<number>(
    names ? `warnings-count:${names}` : null,
    async () => {
      const all = await Promise.all(servers.map((s) => incus<any[]>(s.name, "/1.0/warnings?recursion=1").catch(() => [])));
      return all.flat().filter((w) => w.status === "new").length;
    },
    60000,
  );
  return q.data || 0;
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

function CmdK({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const app = useApp();
  const { data: rows } = useInstances();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  useEffect(() => {
    if (open) {
      setQ("");
      setSel(0);
    }
  }, [open]);
  const go = (to: string) => () => (nav(to), onClose());
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
      { group: "Go to", label: "Operations", icon: ic.pulse, run: go("/operations") },
      { group: "Go to", label: "Warnings", icon: ic.warn, run: go("/warnings") },
      { group: "Go to", label: "Settings", icon: ic.gear, run: go("/settings") },
      { group: "Actions", label: "Create instance", icon: ic.plus, run: go("/instances?create=1") },
      { group: "Actions", label: "Pull image", icon: ic.dl, run: go("/images") },
      { group: "Actions", label: "Add server", icon: ic.host, run: go("/settings/servers") },
      { group: "Actions", label: "Switch to dark mode", icon: ic.screen, run: () => (app.setMode("dark"), onClose()) },
      { group: "Actions", label: "Switch to light mode", icon: ic.screen, run: () => (app.setMode("light"), onClose()) },
    ];
    for (const r of rows || []) {
      list.push({ group: "Instances", label: r.name, meta: `${r.status} · ${r.server}`, icon: r.type === "virtual-machine" ? ic.vm : ic.ct, run: go(`/instances/${r.server}/${r.name}?project=${encodeURIComponent(r.project)}`) });
      if (r.status === "Running") list.push({ group: "Instances", label: `Open terminal in ${r.name}`, icon: ic.term, run: go(`/instances/${r.server}/${r.name}/terminal?project=${encodeURIComponent(r.project)}`) });
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);
  const ql = q.toLowerCase();
  const shown = cmds.filter((c) => !ql || c.label.toLowerCase().includes(ql)).slice(0, 40);
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
        <input autoFocus placeholder="Search instances, pages and actions" value={q} onChange={(e) => (setQ(e.target.value), setSel(0))} onKeyDown={onKey} />
        <kbd>esc</kbd>
      </div>
      <div className="cmdk-list" role="listbox">
        {shown.map((c, i) => {
          const g = c.group !== lastGroup ? (lastGroup = c.group) : null;
          return (
            <Fragment key={c.group + c.label}>
              {g && <div className="cmdk-g">{g}</div>}
              <button className="cmdk-i" aria-selected={i === sel} onMouseMove={() => setSel(i)} onClick={c.run}>
                {c.icon}
                {c.label}
                {c.meta && <span className="meta">{c.meta}</span>}
              </button>
            </Fragment>
          );
        })}
        {!shown.length && <div className="cmdk-g">Nothing matches “{q}”.</div>}
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
