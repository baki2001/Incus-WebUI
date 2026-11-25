import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ui } from "../api";
import { ic } from "../icons";
import { useCrumbs } from "../Shell";
import { BackupSettings } from "./Backups";
import { Security } from "./Security";
import { contrast, DEFAULT_CUSTOM, fitAccent, inkFor, invalidate, isHex, useApp, useData, type AccessEntry, type CustomTheme, type Mode, type RoleName } from "../state";
import { confirmDialog, CopyBtn, Dialog, Field, Menu, Seg, Select, Table, useThumb } from "../ui";
import { DlgForm } from "./InstanceDialogs";

type Section = "appearance" | "security" | "servers" | "users" | "backups" | "about";
const sections: { v: Section; l: string; admin?: boolean; local?: boolean }[] = [
  { v: "appearance", l: "Appearance" },
  { v: "security", l: "Sign-in security", local: true },
  { v: "servers", l: "Servers", admin: true },
  { v: "users", l: "Users and roles", admin: true },
  { v: "backups", l: "Backups", admin: true },
  { v: "about", l: "Updates and about" },
];

export function Settings() {
  const { section = "appearance" } = useParams();
  const nav = useNavigate();
  const { admin, method } = useApp();
  const local = method === "password";
  const navRef = useRef<HTMLElement>(null);
  useThumb(navRef, 'button[aria-current="page"]', [section, admin, local]);
  useEffect(() => {
    navRef.current?.querySelector('button[aria-current="page"]')?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [section]);
  useCrumbs([{ label: "Settings", to: "/settings" }, { label: sections.find((s) => s.v === section)?.l || "" }]);
  return (
    <>
      <div className="ph">
        <h1>Settings</h1>
      </div>
      <div className="set">
        <nav className="set-nav" ref={navRef}>
          {sections.filter((s) => (admin || !s.admin) && (local || !s.local)).map((s) => (
            <button key={s.v} aria-current={section === s.v ? "page" : undefined} onClick={() => nav(`/settings/${s.v}`)}>
              {s.l}
            </button>
          ))}
        </nav>
        <div className="set-body">
          {section === "appearance" && <Appearance />}
          {section === "security" && local && <Security />}
          {section === "servers" && admin && <Servers />}
          {section === "users" && admin && <Users />}
          {section === "backups" && admin && <BackupSettings />}
          {section === "about" && <About />}
        </div>
      </div>
    </>
  );
}

type CustomPreset = { name: string; value: CustomTheme };
const CUSTOM_PRESETS: CustomPreset[] = [
  { name: "Forest", value: { base: "porcelain", accent: "#2d6a4f", cta: "#d95d39", sidebar: "#1b4332" } },
  { name: "Ocean", value: { base: "porcelain", accent: "#1d5fa7", cta: "#0f9d9a", sidebar: "#0f2c4c" } },
  { name: "Plum", value: { base: "porcelain", accent: "#6d3b7d", cta: "#c94c4c", sidebar: "#3b1d47" } },
  { name: "Amber", value: { base: "porcelain", accent: "#9a5b13", cta: "#2a7b88", sidebar: "#3e2716" } },
  { name: "Midnight", value: { base: "graphite", accent: "#74b3ff", cta: "#38bdf8", sidebar: "#101828" } },
  { name: "Ember", value: { base: "graphite", accent: "#f59e6c", cta: "#2eb3b2", sidebar: "#2a1712" } },
];

function Appearance() {
  const app = useApp();
  const c = app.custom;
  const [accentIn, setAccentIn] = useState(c.accent);
  const [ctaIn, setCtaIn] = useState(c.cta);
  const [sideIn, setSideIn] = useState(c.sidebar || "#1b4332");
  useEffect(() => {
    setAccentIn(c.accent);
    setCtaIn(c.cta);
    if (c.sidebar) setSideIn(c.sidebar);
  }, [c.accent, c.cta, c.sidebar]);

  const patchCustom = (next: Partial<CustomTheme>) => {
    const merged = { ...c, ...next };
    app.setCustom(merged);
    if (app.mode !== "custom") app.setMode("custom");
  };

  const fittedAccent = fitAccent(c.accent, c.base);
  const baseBg = c.base === "graphite" ? "#1e2026" : "#f1f2f5";
  const accentRatio = contrast(fittedAccent, baseBg);
  const ctaColor = isHex(c.cta) ? c.cta : fittedAccent;
  const ctaInk = inkFor(ctaColor);
  const ctaRatio = contrast(ctaColor, ctaInk);
  const sameCta = c.cta.toLowerCase() === c.accent.toLowerCase();
  const isDefaultCustom =
    c.base === DEFAULT_CUSTOM.base &&
    c.accent.toLowerCase() === DEFAULT_CUSTOM.accent.toLowerCase() &&
    c.cta.toLowerCase() === DEFAULT_CUSTOM.cta.toLowerCase() &&
    c.sidebar.toLowerCase() === DEFAULT_CUSTOM.sidebar.toLowerCase();

  // Preview colours: page, sidebar, sidebar lines, card, card lines, button.
  type Pv = { page: string; side: string; sideInk: string; card: string; cardInk: string; btn: string };
  const customPv: Pv =
    c.base === "graphite"
      ? {
          page: "#16171b",
          side: c.sidebar || "transparent",
          sideInk: c.sidebar ? inkFor(c.sidebar) : "#c2c6d1",
          card: "#1e2026",
          cardInk: "#f1f3f7",
          btn: ctaColor,
        }
      : {
          page: "#f1f2f5",
          side: c.sidebar || "transparent",
          sideInk: c.sidebar ? inkFor(c.sidebar) : "#16181d",
          card: "#ffffff",
          cardInk: "#16181d",
          btn: ctaColor,
        };

  const themes: { v: Mode; l: string; note: string; pv: Pv }[] = [
    { v: "indigo", l: "Indigo", note: "Stone and indigo", pv: { page: "#ebecef", side: "#142950", sideInk: "#ffffff", card: "#ffffff", cardInk: "#101a30", btn: "#db390c" } },
    { v: "porcelain", l: "Porcelain", note: "Crisp light", pv: { page: "#f1f2f5", side: "transparent", sideInk: "#16181d", card: "#ffffff", cardInk: "#16181d", btn: "#3456bd" } },
    { v: "graphite", l: "Graphite", note: "Soft dark", pv: { page: "#16171b", side: "transparent", sideInk: "#c2c6d1", card: "#1e2026", cardInk: "#f1f3f7", btn: "#8fa8f8" } },
    { v: "terracotta", l: "Terracotta", note: "Sand, clay and teal", pv: { page: "#f3e7dc", side: "#772f10", sideInk: "#fdf7f2", card: "#fffdfb", cardInk: "#2b140a", btn: "#2eb3b2" } },
    { v: "custom", l: "Custom", note: "Your palette", pv: customPv },
  ];

  return (
    <section className="set-sec">
      <h2>
        Theme<span className="scope-tag">Just for you, in this browser</span>
      </h2>
      <p>Pick the look you prefer. Changes apply right away and only affect you.</p>
      <div className="tcards">
        {themes.map((t) => (
          <button key={t.v} className="tcard press" aria-pressed={app.mode === t.v} onClick={() => app.setMode(t.v)}>
            <div className="prev one">
              <div className="pv" style={{ background: t.pv.page }}>
                <div className="ps" style={{ background: t.pv.side }}>
                  <i style={{ background: t.pv.sideInk }} />
                  <i style={{ background: t.pv.sideInk }} />
                  <i style={{ background: t.pv.sideInk }} />
                </div>
                <div className="pm">
                  <div className="c" style={{ background: t.pv.card }}>
                    <i style={{ background: t.pv.cardInk }} />
                    <i style={{ background: t.pv.cardInk }} />
                  </div>
                  <div className="b" style={{ background: t.pv.btn }} />
                </div>
              </div>
            </div>
            <span className="nm">
              <span className="ck" />
              {t.l}
              <small>{t.note}</small>
            </span>
          </button>
        ))}
      </div>

      {app.mode === "custom" && (
        <div className="cust-card">
          <div className="cust-head">
            <div>
              <h3>Custom palette</h3>
              <p>Pick a base surface, then tune the sidebar, accent and main button colours.</p>
            </div>
            <button
              className="btn btn-q btn-sm"
              disabled={isDefaultCustom}
              onClick={() => patchCustom(DEFAULT_CUSTOM)}
            >
              Reset
            </button>
          </div>

          <div className="cust-presets">
            <span className="cust-presets-lbl">Starters</span>
            {CUSTOM_PRESETS.map((p) => (
              <button
                key={p.name}
                type="button"
                className="cust-preset press"
                onClick={() => patchCustom(p.value)}
              >
                <span className="cust-dots">
                  <i style={{ background: p.value.sidebar || (p.value.base === "graphite" ? "#1e2026" : "#f1f2f5") }} />
                  <i style={{ background: p.value.accent }} />
                  <i style={{ background: p.value.cta }} />
                </span>
                {p.name}
              </button>
            ))}
          </div>

          <div className="cust-row">
            <div className="cust-row-lbl">
              <b>Base surface</b>
              <small>Light or dark cards, tables and backgrounds.</small>
            </div>
            <Seg
              label="Base surface"
              value={c.base}
              onChange={(base) => patchCustom({ base })}
              options={[
                { v: "porcelain", l: "Porcelain (light)" },
                { v: "graphite", l: "Graphite (dark)" },
              ]}
            />
          </div>

          <div className="cust-grid">
            <div className="cust-slot">
              <div className="cust-slot-h">
                <span>Accent</span>
                <small>Links and focus</small>
              </div>
              <div className="cust-pick">
                <input
                  type="color"
                  value={isHex(accentIn) ? accentIn : c.accent}
                  onChange={(e) => {
                    const v = e.target.value;
                    setAccentIn(v);
                    patchCustom({ accent: v, ...(sameCta ? { cta: v } : {}) });
                  }}
                  aria-label="Accent colour"
                />
                <div className="field">
                  <input
                    className="mono"
                    value={accentIn}
                    onChange={(e) => {
                      const v = e.target.value;
                      setAccentIn(v);
                      if (isHex(v)) patchCustom({ accent: v, ...(sameCta ? { cta: v } : {}) });
                    }}
                    placeholder="#2d6a4f"
                  />
                </div>
              </div>
              <div className="cust-slot-f">
                <span>{fittedAccent.toLowerCase() !== c.accent.toLowerCase() ? `Adjusted to ${fittedAccent}` : "Readable on surface"}</span>
                <span className="cust-badge">{accentRatio.toFixed(1)}:1</span>
              </div>
            </div>

            <div className="cust-slot">
              <div className="cust-slot-h">
                <span>Primary button</span>
                <small>Main actions</small>
              </div>
              <div className="cust-pick">
                <input
                  type="color"
                  value={isHex(ctaIn) ? ctaIn : ctaColor}
                  onChange={(e) => {
                    const v = e.target.value;
                    setCtaIn(v);
                    patchCustom({ cta: v });
                  }}
                  aria-label="Primary button colour"
                />
                <div className="field">
                  <input
                    className="mono"
                    value={ctaIn}
                    onChange={(e) => {
                      const v = e.target.value;
                      setCtaIn(v);
                      if (isHex(v)) patchCustom({ cta: v });
                    }}
                    placeholder="#d95d39"
                  />
                </div>
              </div>
              <div className="cust-slot-f">
                {sameCta ? (
                  <span>Matches accent</span>
                ) : (
                  <button type="button" className="linkish" onClick={() => patchCustom({ cta: c.accent })}>
                    Match accent
                  </button>
                )}
                <span className="cust-badge">{ctaRatio.toFixed(1)}:1</span>
              </div>
            </div>

            <div className="cust-slot">
              <div className="cust-slot-h">
                <span>Sidebar</span>
                <button
                  type="button"
                  className="linkish"
                  onClick={() => patchCustom({ sidebar: c.sidebar ? "" : sideIn || "#1b4332" })}
                >
                  {c.sidebar ? "Match surface" : "Tint sidebar"}
                </button>
              </div>
              {c.sidebar ? (
                <>
                  <div className="cust-pick">
                    <input
                      type="color"
                      value={isHex(sideIn) ? sideIn : c.sidebar}
                      onChange={(e) => {
                        const v = e.target.value;
                        setSideIn(v);
                        patchCustom({ sidebar: v });
                      }}
                      aria-label="Sidebar colour"
                    />
                    <div className="field">
                      <input
                        className="mono"
                        value={sideIn}
                        onChange={(e) => {
                          const v = e.target.value;
                          setSideIn(v);
                          if (isHex(v)) patchCustom({ sidebar: v });
                        }}
                        placeholder="#1b4332"
                      />
                    </div>
                  </div>
                  <div className="cust-slot-f">
                    <span>Sidebar text adapts automatically.</span>
                  </div>
                </>
              ) : (
                <div className="cust-slot-f" style={{ marginTop: "auto" }}>
                  <span>Uses the {c.base === "graphite" ? "Graphite" : "Porcelain"} background.</span>
                </div>
              )}
            </div>
          </div>

          <div className="cust-preview">
            <span className="cust-preview-lbl">Preview</span>
            <button type="button" className="btn btn-p btn-sm">Primary action</button>
            <button type="button" className="btn btn-s btn-sm">Secondary</button>
            <span className="rbadge admin">Selected</span>
            <span className="linkish" style={{ cursor: "default" }}>Sample link</span>
          </div>
        </div>
      )}
    </section>
  );
}

function Servers() {
  const app = useApp();
  const cert = useData<{ pem: string; fingerprint: string }>("client-cert", () => ui("/client-cert"));
  const [name, setName] = useState("");
  const [how, setHow] = useState<"token" | "url">("token");
  const [token, setToken] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    app.reloadServers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const add = async () => {
    setBusy(true);
    setErr("");
    try {
      const st = await ui<any>("/servers", { method: "POST", body: how === "token" ? { name, token } : { name, url } });
      await app.reloadServers();
      invalidate("");
      setName("");
      setToken("");
      setUrl("");
      app.toast(st.trusted ? `${name} connected` : `${name} added. Trust this UI's certificate on it to finish.`);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (n: string) => {
    if (!(await confirmDialog({ title: `Remove ${n}?`, body: "The UI forgets this server. Nothing on the server changes.", confirm: "Remove", danger: true }))) return;
    await ui(`/servers/${encodeURIComponent(n)}`, { method: "DELETE" });
    if (app.scope === n) app.setScope("*");
    app.reloadServers();
  };
  return (
    <>
      <section className="set-sec">
        <h2>Connected servers</h2>
        <p>The UI talks to each server with its own certificate. Users of the UI act through it.</p>
        <div className="panel">
          {app.servers.map((s) => (
            <div className="snap" key={s.name}>
              <span className={"st " + (s.online && s.trusted ? "running" : "error")} style={{ fontSize: 0 }} />
              <div style={{ minWidth: 0 }}>
                <b style={{ fontWeight: 500 }}>{s.name}</b>
                <div className="dim mono" style={{ fontSize: 12 }}>
                  {s.url}
                </div>
                {s.error && <div className="bad" style={{ fontSize: 12.5 }}>{s.error}</div>}
              </div>
              <span className="r">
                <button className="btn btn-q btn-sm" onClick={() => remove(s.name)}>
                  Remove
                </button>
              </span>
            </div>
          ))}
          {!app.servers.length && <div className="pfoot" style={{ borderTop: 0 }}>No servers yet.</div>}
        </div>
      </section>
      <section className="set-sec">
        <h2>Add a server</h2>
        <p>
          The easiest way is a trust token. On the Incus server, run <span className="mono">incus config trust add incus-webui</span> and paste what it prints. The server needs <span className="mono">core.https_address</span> set.
        </p>
        <div className="set-form">
          <Field label="Name" hint="Shown in the sidebar, like atlas or nas.">
            <div className="field">
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="atlas" />
            </div>
          </Field>
          <Seg value={how} onChange={setHow} options={[{ v: "token", l: "Trust token" }, { v: "url", l: "Address" }]} />
          {how === "token" ? (
            <Field label="Trust token">
              <div className="field">
                <textarea className="mono" rows={3} value={token} onChange={(e) => setToken(e.target.value)} />
              </div>
            </Field>
          ) : (
            <Field label="Address" hint="https://host:8443, or unix:///var/lib/incus/unix.socket when the UI runs on the host. Then trust the certificate below on the server.">
              <div className="field">
                <input className="mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://192.168.1.10:8443" />
              </div>
            </Field>
          )}
          {err && <div className="bad">{err}</div>}
          <div>
            <button className="btn btn-s press" disabled={busy || !name || (how === "token" ? !token : !url)} onClick={add}>
              {busy ? "Connecting…" : "Add server"}
            </button>
          </div>
        </div>
      </section>
      <section className="set-sec">
        <h2>This UI's certificate</h2>
        <p>
          Only needed if you add a server by address. Save it as <span className="mono">incus-webui.crt</span> on the server and run <span className="mono">incus config trust add-certificate incus-webui.crt</span>.
        </p>
        {cert.data && (
          <div className="panel">
            <div className="ptitle">
              <h2>Fingerprint</h2>
              <span className="mono" style={{ overflowWrap: "anywhere" }}>
                {cert.data.fingerprint.slice(0, 32)}…
              </span>
              <span className="r">
                <CopyBtn text={cert.data.pem} />
              </span>
            </div>
            <pre className="code" style={{ maxHeight: 180 }}>
              {cert.data.pem}
            </pre>
          </div>
        )}
      </section>
    </>
  );
}

type UiUser = { username: string; totp?: boolean; passkeys?: number };

const roleOptions = [
  { v: "viewer", l: "Viewer: only look" },
  { v: "operator", l: "Operator: start, stop, console, files" },
  { v: "manager", l: "Manager: create, change, delete" },
  { v: "admin", l: "Admin: everything, also users and servers" },
];
const roleRank: Record<string, number> = { viewer: 1, operator: 2, manager: 3, admin: 4 };
const roleLabel = (r: string) => r[0].toUpperCase() + r.slice(1);
const everywhere = (e: AccessEntry) => e.server === "*" && e.project === "*";

// What a user's own access entries add up to, for the user list.
function roleSummary(entries: AccessEntry[], name: string) {
  const mine = entries.filter((e) => e.who === `user:${name}`);
  if (!mine.length) return null;
  const top = mine.reduce((a, b) => (roleRank[b.role] > roleRank[a.role] ? b : a));
  const scoped = mine.length > 1 || !everywhere(top);
  return { role: top.role, label: roleLabel(top.role), title: mine.map((e) => `${roleLabel(e.role)} on ${e.server === "*" ? "every server" : e.server}, ${e.project === "*" ? "every project" : `project ${e.project}`}`).join("\n"), scoped };
}

const saveAccess = (access: AccessEntry[]) => ui("/access", { method: "PUT", body: { access } }).then(() => invalidate("ui-access"));

function Users() {
  const app = useApp();
  const nav = useNavigate();
  const q = useData<{ users: UiUser[]; oidc?: { issuer: string; allowed_emails?: string[]; allowed_groups?: string[] } }>("ui-users", () => ui("/users"));
  const acc = useData<{ access: AccessEntry[] }>("ui-access", () => ui("/access"));
  const [adding, setAdding] = useState(false);
  const [pwFor, setPwFor] = useState("");
  const [roleFor, setRoleFor] = useState("");
  const users = q.data?.users || [];
  const access = acc.data?.access || [];
  const resetSignIn = async (name: string) => {
    if (!(await confirmDialog({ title: `Reset sign-in for ${name}?`, body: "Their two-factor sign-in and all their passkeys are removed and they are signed out everywhere. They can sign in with their password and set them up again.", confirm: "Reset", danger: true }))) return;
    try {
      await ui(`/users/${encodeURIComponent(name)}/reset-sign-in`, { method: "POST" });
      app.toast(`Sign-in reset for ${name}`);
      invalidate("ui-users");
    } catch (e: any) {
      app.fail(e, "Could not reset the sign-in.");
    }
  };
  const del = async (name: string) => {
    if (!(await confirmDialog({ title: `Remove ${name}?`, body: "They can't sign in with a password any more. Their roles are removed too.", confirm: "Remove", danger: true }))) return;
    try {
      await ui(`/users/${encodeURIComponent(name)}`, { method: "DELETE" });
      app.toast(`${name} removed`);
      invalidate("ui-users");
      invalidate("ui-access");
    } catch (e: any) {
      app.fail(e, "Could not remove the user.");
    }
  };
  return (
    <>
      <section className="set-sec">
        <div className="set-sec-h">
          <h2>Local users</h2>
          <span className="sec-count">{users.length}</span>
          <button className="btn btn-p btn-sm press" onClick={() => setAdding(true)}>
            {ic.plus}Add user
          </button>
        </div>
        <div className="panel">
          {users.map((x) => {
            const me = x.username === app.user;
            const canReset = !me && (x.totp || !!x.passkeys);
            const canDel = !me && users.length > 1;
            const role = roleSummary(access, x.username);
            const hasStrongAuth = x.totp || !!x.passkeys;
            return (
              <div className="usr-row" key={x.username}>
                <span className={"av" + (me ? " me" : "")}>
                  {x.username.replace(/@.*/, "").split(/[._\s-]+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase()}
                </span>
                <div className="usr-id">
                  <div className="usr-name">
                    <span>{x.username}</span>
                    {me && <span className="usr-you">You</span>}
                  </div>
                  <div className="usr-sec">
                    {hasStrongAuth ? (
                      <>
                        {x.totp && <span className="usr-sec-ok"><i />2FA on</span>}
                        {!!x.passkeys && (
                          <span className="usr-sec-ok">
                            <i />
                            {x.passkeys === 1 ? "1 passkey" : `${x.passkeys} passkeys`}
                          </span>
                        )}
                      </>
                    ) : (
                      <span>Password only</span>
                    )}
                  </div>
                </div>
                <span className="r usr-r">
                  {role ? (
                    <span className={`rbadge ${role.role}`} title={role.title}>
                      {role.label}
                      {role.scoped && " +"}
                    </span>
                  ) : (
                    <span className="dim" title="Only entries for everyone or for groups apply.">No direct role</span>
                  )}
                  {me ? (
                    <button className="btn btn-s btn-sm press" onClick={() => nav("/settings/security")}>
                      Sign-in security
                    </button>
                  ) : (
                    <Menu
                      button={(p) => (
                        <button className="btn btn-q ib btn-sm" aria-label={`Actions for ${x.username}`} {...p}>
                          {ic.more}
                        </button>
                      )}
                    >
                      {(close) => (
                        <>
                          <button onClick={() => (close(), setRoleFor(x.username))}>Change role</button>
                          <button onClick={() => (close(), setPwFor(x.username))}>Reset password</button>
                          {canReset && <button onClick={() => (close(), resetSignIn(x.username))}>Reset 2FA and passkeys</button>}
                          {canDel && (
                            <button className="danger" onClick={() => (close(), del(x.username))}>
                              {ic.trash}Remove
                            </button>
                          )}
                        </>
                      )}
                    </Menu>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </section>
      <AddUserDialog open={adding} onClose={() => setAdding(false)} taken={users.map((u) => u.username)} />
      <PasswordDialog name={pwFor} onClose={() => setPwFor("")} />
      <UserRoleDialog name={roleFor} access={access} onClose={() => setRoleFor("")} />
      <Roles />
      <section className="set-sec">
        <h2>
          Single sign-on <span className="ac">(OIDC)</span>
        </h2>
        <div className="panel oidc-card">
          {q.data?.oidc ? (
            <>
              <div className="oidc-top">
                <span className="st running">Connected</span>
                <span className="mono">{q.data.oidc.issuer}</span>
              </div>
              {(q.data.oidc.allowed_emails?.length || q.data.oidc.allowed_groups?.length) && (
                <div className="oidc-meta">
                  {q.data.oidc.allowed_emails?.map((em) => (
                    <span className="tag mono" key={`e:${em}`}>{em}</span>
                  ))}
                  {q.data.oidc.allowed_groups?.map((g) => (
                    <span className="tag" key={`g:${g}`}>group: {g}</span>
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              <div className="oidc-top">
                <span className="st">Off</span>
                <b>Not configured</b>
              </div>
              <p>
                Add an <span className="mono">oidc</span> block to <span className="mono">config.yaml</span> and restart to let people sign in with your identity provider.
              </p>
            </>
          )}
        </div>
      </section>
    </>
  );
}

function AddUserDialog({ open, onClose, taken }: { open: boolean; onClose: () => void; taken: string[] }) {
  const app = useApp();
  const [u, setU] = useState("");
  const [p, setP] = useState("");
  const [role, setRole] = useState<RoleName>("viewer");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) (setU(""), setP(""), setRole("viewer"), setErr(""));
  }, [open]);
  const dup = taken.includes(u.trim()) ? "A user with that name already exists." : "";
  return (
    <Dialog open={open} onClose={onClose} size="sm" dirty={!!u || !!p}>
      <DlgForm
        title="Add a user"
        intro="They sign in with this name and password. They can add two-factor sign-in and passkeys themselves."
        confirm={busy ? "Adding…" : "Add user"}
        disabled={busy || !u.trim() || p.length < 10 || !!dup}
        onClose={onClose}
        onSubmit={async () => {
          setBusy(true);
          setErr("");
          try {
            await ui("/users", { method: "POST", body: { username: u.trim(), password: p, role } });
            app.toast(`${u.trim()} added as ${role}`);
            invalidate("ui-users");
            invalidate("ui-access");
            onClose();
          } catch (e: any) {
            setErr(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Username" hint={dup} bad={!!dup}>
          <div className="field">
            <input autoFocus value={u} onChange={(e) => setU(e.target.value)} autoComplete="off" />
          </div>
        </Field>
        <Field label="Password" hint="At least 10 characters.">
          <div className="field">
            <input type="password" value={p} onChange={(e) => setP(e.target.value)} autoComplete="new-password" />
          </div>
        </Field>
        <Field label="Role" hint="On every server and project. Narrow it under Roles.">
          <Select value={role} onChange={(v) => setRole(v as RoleName)} options={roleOptions} />
        </Field>
        {err && <div className="bad">{err}</div>}
      </DlgForm>
    </Dialog>
  );
}

function PasswordDialog({ name, onClose }: { name: string; onClose: () => void }) {
  const app = useApp();
  const [p, setP] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (name) (setP(""), setErr(""));
  }, [name]);
  return (
    <Dialog open={!!name} onClose={onClose} size="sm" dirty={!!p}>
      <DlgForm
        title={`Reset password for ${name}`}
        intro="They are signed out everywhere and sign in with the new password. Their two-factor sign-in and passkeys stay."
        confirm={busy ? "Saving…" : "Reset password"}
        disabled={busy || p.length < 10}
        onClose={onClose}
        onSubmit={async () => {
          setBusy(true);
          setErr("");
          try {
            await ui(`/users/${encodeURIComponent(name)}`, { method: "PUT", body: { password: p } });
            app.toast(`Password changed for ${name}`);
            onClose();
          } catch (e: any) {
            setErr(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="New password" hint="At least 10 characters.">
          <div className="field">
            <input type="password" autoFocus value={p} onChange={(e) => (setP(e.target.value), setErr(""))} autoComplete="new-password" />
          </div>
        </Field>
        {err && <div className="bad">{err}</div>}
      </DlgForm>
    </Dialog>
  );
}

// UserRoleDialog sets the user's role on every server and project. Entries
// for single servers or projects are left alone and edited under Roles.
function UserRoleDialog({ name, access, onClose }: { name: string; access: AccessEntry[]; onClose: () => void }) {
  const app = useApp();
  const who = `user:${name}`;
  const cur = access.find((e) => e.who === who && everywhere(e))?.role || "";
  const scoped = access.filter((e) => e.who === who && !everywhere(e)).length;
  const [role, setRole] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (name) (setRole(cur), setErr(""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);
  return (
    <Dialog open={!!name} onClose={onClose} size="sm">
      <DlgForm
        title={`Change role for ${name}`}
        intro={
          scoped
            ? `This role holds on every server and project. ${name} also has ${scoped === 1 ? "one entry" : `${scoped} entries`} for single servers or projects. Change those under Roles.`
            : "This role holds on every server and project. To give a role on one project only, add an entry under Roles."
        }
        confirm={busy ? "Saving…" : "Save"}
        disabled={busy || role === cur}
        onClose={onClose}
        onSubmit={async () => {
          setBusy(true);
          setErr("");
          const rest = access.filter((e) => !(e.who === who && everywhere(e)));
          try {
            await saveAccess(role ? [...rest, { who, server: "*", project: "*", role: role as RoleName }] : rest);
            app.toast(role ? `${name} is now ${role}` : `Removed the role of ${name}`);
            onClose();
          } catch (e: any) {
            setErr(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Role">
          <Select value={role} onChange={setRole} options={[...roleOptions, { v: "", l: "None: only roles for everyone or groups" }]} />
        </Field>
        {err && <div className="bad">{err}</div>}
      </DlgForm>
    </Dialog>
  );
}

const roleCards: { v: RoleName; l: string; desc: string }[] = [
  { v: "viewer", l: "Viewer", desc: "Read-only access to servers and instances." },
  { v: "operator", l: "Operator", desc: "Start, stop, console and files." },
  { v: "manager", l: "Manager", desc: "Create, change and delete resources." },
  { v: "admin", l: "Admin", desc: "Full access, including users and servers." },
];

function formatWho(who: string) {
  if (who === "*") return { kind: "All", name: "Everyone who can sign in", plain: true };
  if (who.startsWith("user:")) return { kind: "Local", name: who.slice(5), plain: false };
  if (who.startsWith("sso:")) return { kind: "SSO", name: who.slice(4), plain: false };
  if (who.startsWith("group:")) return { kind: "Group", name: who.slice(6), plain: false };
  return { kind: "User", name: who, plain: false };
}

// Roles lists every access entry. Adding and editing happen in a dialog, and
// each change is saved right away.
function Roles() {
  const app = useApp();
  const q = useData<{ access: AccessEntry[] }>("ui-access", () => ui("/access"));
  const [edit, setEdit] = useState<{ i: number; e: AccessEntry } | null>(null);
  const rows = q.data?.access;
  const remove = async (i: number) => {
    if (!rows) return;
    const r = rows[i];
    const admins = rows.filter((e) => e.role === "admin");
    const last = r.role === "admin" && admins.length === 1;
    if (!(await confirmDialog({ title: `Remove the entry for ${r.who}?`, body: last ? "This is the only admin entry. Without it nobody can manage users, roles or servers." : "They lose this role. Other entries that fit them still apply.", confirm: "Remove", danger: true }))) return;
    try {
      await saveAccess(rows.filter((_, j) => j !== i));
      app.toast("Entry removed");
    } catch (e) {
      app.fail(e, "Could not remove the entry.");
    }
  };
  type Row = AccessEntry & { i: number };
  return (
    <section className="set-sec">
      <div className="set-sec-h">
        <h2>Roles</h2>
        {rows && <span className="sec-count">{rows.length}</span>}
        <button className="btn btn-s btn-sm press" disabled={!rows} onClick={() => setEdit({ i: -1, e: { who: "user:", server: "*", project: "*", role: "viewer" } })}>
          {ic.plus}Add entry
        </button>
      </div>
      <p>Each entry gives someone a role on a server and project. Someone with several entries gets the highest role that fits.</p>
      <div className="role-legend">
        {roleCards.map((rc) => (
          <div className="role-card" key={rc.v}>
            <span className={`rbadge ${rc.v}`}>{rc.l}</span>
            <p>{rc.desc}</p>
          </div>
        ))}
      </div>
      <Table<Row>
        rows={rows?.map((e, i) => ({ ...e, i }))}
        loading={!rows}
        rowKey={(r) => String(r.i)}
        onRow={(r) => setEdit({ i: r.i, e: r })}
        empty="No entries yet."
        initial={{ k: "who", asc: true }}
        cols={[
          {
            k: "who",
            label: "Who",
            sort: (r) => r.who,
            cell: (r) => {
              const w = formatWho(r.who);
              return (
                <span className="who-cell">
                  <span className="who-kind">{w.kind}</span>
                  <span className={w.plain ? undefined : "mono"}>{w.name}</span>
                </span>
              );
            },
          },
          {
            k: "server",
            label: "Server",
            cls: "hide-s",
            sort: (r) => r.server,
            cell: (r) => (r.server === "*" ? <span className="dim">Every server</span> : <span className="scope-pill">{r.server}</span>),
          },
          {
            k: "project",
            label: "Project",
            sort: (r) => r.project,
            cell: (r) => (r.project === "*" ? <span className="dim">Every project</span> : <span className="scope-pill">{r.project}</span>),
          },
          { k: "role", label: "Role", sort: (r) => roleRank[r.role], cell: (r) => <span className={`rbadge ${r.role}`}>{roleLabel(r.role)}</span> },
          {
            k: "act",
            label: "",
            cls: "right",
            cell: (r) => (
              <span onClick={(e) => e.stopPropagation()}>
                <Menu
                  button={(p) => (
                    <button className="btn btn-q ib btn-sm" aria-label={`Actions for ${r.who}`} {...p}>
                      {ic.more}
                    </button>
                  )}
                >
                  {(close) => (
                    <>
                      <button onClick={() => (close(), setEdit({ i: r.i, e: r }))}>{ic.edit}Edit</button>
                      <button className="danger" onClick={() => (close(), remove(r.i))}>
                        {ic.trash}Remove
                      </button>
                    </>
                  )}
                </Menu>
              </span>
            ),
          },
        ]}
      />
      <RoleDialog edit={edit} rows={rows || []} onClose={() => setEdit(null)} />
    </section>
  );
}

const whoKinds = [
  { v: "user", l: "Local user" },
  { v: "sso", l: "Single sign-on user" },
  { v: "group", l: "SSO group" },
  { v: "*", l: "Everyone who can sign in" },
];

function RoleDialog({ edit, rows, onClose }: { edit: { i: number; e: AccessEntry } | null; rows: AccessEntry[]; onClose: () => void }) {
  const app = useApp();
  const users = useData<{ users: UiUser[] }>("ui-users", () => ui("/users"));
  const [kind, setKind] = useState("user");
  const [name, setName] = useState("");
  const [server, setServer] = useState("*");
  const [project, setProject] = useState("*");
  const [role, setRole] = useState<RoleName>("viewer");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!edit) return;
    const w = edit.e.who;
    const k = w === "*" ? "*" : w.includes(":") ? w.slice(0, w.indexOf(":")) : "user";
    setKind(whoKinds.some((x) => x.v === k) ? k : "user");
    setName(w === "*" ? "" : w.slice(w.indexOf(":") + 1));
    setServer(edit.e.server || "*");
    setProject(edit.e.project || "*");
    setRole(edit.e.role);
    setErr("");
  }, [edit]);
  const isNew = edit?.i === -1;
  const who = kind === "*" ? "*" : `${kind}:${name.trim()}`;
  const admin = role === "admin";
  const entry: AccessEntry = { who, server: admin ? "*" : server, project: admin ? "*" : project.trim() || "*", role };
  const same = (a: AccessEntry, b: AccessEntry) => a.who === b.who && a.server === b.server && a.project === b.project && a.role === b.role;
  const dup = rows.some((r, j) => j !== edit?.i && same(r, entry));
  const unchanged = !!edit && !isNew && same(edit.e, entry);
  const servers = ["*", ...app.servers.map((s) => s.name)];
  const localNames = (users.data?.users || []).map((u) => u.username);
  return (
    <Dialog open={!!edit} onClose={onClose} size="sm" dirty={!unchanged && !isNew}>
      {edit && (
        <DlgForm
          title={isNew ? "Add a role entry" : "Edit role entry"}
          confirm={busy ? "Saving…" : isNew ? "Add entry" : "Save"}
          disabled={busy || (kind !== "*" && !name.trim()) || dup || unchanged}
          onClose={onClose}
          onSubmit={async () => {
            setBusy(true);
            setErr("");
            try {
              await saveAccess(isNew ? [...rows, entry] : rows.map((r, j) => (j === edit.i ? entry : r)));
              app.toast(isNew ? "Entry added" : "Entry saved");
              onClose();
            } catch (e: any) {
              setErr(e.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Who">
            <Select value={kind} onChange={setKind} options={whoKinds} />
          </Field>
          {kind === "user" && localNames.length > 0 ? (
            <Field label="User">
              <Select value={name} onChange={setName} options={[...(localNames.includes(name) ? [] : [{ v: name, l: name || "Pick a user" }]), ...localNames]} />
            </Field>
          ) : (
            kind !== "*" && (
              <Field label={kind === "group" ? "Group name" : kind === "sso" ? "Email or SSO name" : "Username"}>
                <div className="field">
                  <input className="mono" autoFocus value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
                </div>
              </Field>
            )
          )}
          <Field label="Role">
            <Select value={role} onChange={(v) => setRole(v as RoleName)} options={roleOptions} />
          </Field>
          <Field label="Server" hint={admin ? "Admins have their role everywhere." : undefined}>
            <Select disabled={admin} value={entry.server} onChange={setServer} options={servers.includes(entry.server) ? servers.map((s) => ({ v: s, l: s === "*" ? "Every server" : s })) : [...servers, entry.server]} />
          </Field>
          <Field label="Project" hint={admin ? undefined : "A project name, or * for every project."}>
            <div className="field">
              <input className="mono" disabled={admin} value={entry.project} onChange={(e) => setProject(e.target.value)} placeholder="*" />
            </div>
          </Field>
          {dup && <div className="bad">This entry already exists.</div>}
          {err && <div className="bad">{err}</div>}
        </DlgForm>
      )}
    </Dialog>
  );
}


export type UpdateInfo = {
  current: string;
  channel?: "stable" | "dev";
  can_update: boolean;
  reason?: string;
  updating?: boolean;
  error?: string;
  newer?: boolean;
  latest?: { tag: string; url: string; notes: string; published: string };
};

function About() {
  const app = useApp();
  const q = useData<UpdateInfo>("ui-update", () => ui("/update"));
  const [busy, setBusy] = useState<"" | "check" | "update" | "restart">("");
  const [result, setResult] = useState<{ text: string; bad?: boolean } | null>(null);
  const u = q.data;

  const check = async () => {
    setBusy("check");
    setResult(null);
    try {
      const d = await ui<UpdateInfo>("/update?refresh=1");
      invalidate("ui-update");
      if (d.error) setResult({ text: `${d.error}. Check the server's internet access and try again.`, bad: true });
      else if (d.newer) setResult({ text: `${d.latest!.tag} is available.` });
      else setResult({ text: `Up to date (${d.current}).` });
    } catch (e: any) {
      setResult({ text: `Couldn't check for updates: ${e.message}`, bad: true });
    }
    setBusy("");
  };

  const setChannel = async (channel: "stable" | "dev") => {
    setBusy("check");
    setResult(null);
    try {
      await ui("/update/channel", { method: "PUT", body: { channel } });
      invalidate("ui-update");
    } catch (e: any) {
      app.fail(e, "Could not change the update channel.");
    }
    setBusy("");
  };

  const update = async () => {
    if (!u?.latest) return;
    const ok = await confirmDialog({
      title: `Update to ${u.latest.tag}?`,
      body: "The UI downloads the new version, checks it and restarts. Open terminals and consoles disconnect for a few seconds.",
      confirm: "Update",
    });
    if (!ok) return;
    setBusy("update");
    try {
      const r = await ui<{ version: string }>("/update", { method: "POST" });
      setBusy("restart");
      // Wait for the new binary to answer, then load its UI.
      for (let i = 0; i < 60; i++) {
        await new Promise((res) => setTimeout(res, 1000));
        try {
          const v = await ui<{ version: string }>("/version");
          if (v.version === r.version) {
            location.reload();
            return;
          }
        } catch {
          /* still restarting */
        }
      }
      app.toast("The update was installed, but the UI didn't come back within a minute. Check the service log.");
    } catch (e: any) {
      app.fail(e, "Could not install the update.");
    }
    setBusy("");
  };

  return (
    <>
      <section className="set-sec">
        <h2>Updates</h2>
        <p>
          This is version {u?.current || "…"}.{" "}
          {u?.error
            ? u.error
            : u?.newer
              ? `Version ${u.latest!.tag} is available.`
              : u?.latest
                ? u.channel === "dev"
                  ? "It's the newest dev build."
                  : "It's the newest release."
                : ""}
        </p>
        {app.admin && (
          <div className="upd-chan">
            <Seg
              label="Update channel"
              value={u?.channel || "stable"}
              onChange={setChannel}
              options={[
                { v: "stable", l: "Stable" },
                { v: "dev", l: "Dev" },
              ]}
            />
            <p className="upd-note">
              {u?.channel === "dev"
                ? "Dev builds come from the dev branch and can break. Switch back to Stable to return to the latest release."
                : "Stable gets releases. Dev gets every change merged into the dev branch, to test it before a release."}
            </p>
          </div>
        )}
        <div className="upd-row">
          {u?.newer && u.can_update && app.admin && (
            <button className="btn btn-p press" disabled={!!busy || u.updating} onClick={update}>
              {busy === "update" ? "Downloading…" : busy === "restart" ? "Restarting…" : `Update to ${u.latest!.tag}`}
            </button>
          )}
          <button className="btn btn-s press" disabled={!!busy} onClick={check}>
            {busy === "check" ? "Checking…" : "Check now"}
          </button>
          {u?.latest && (
            <a className="btn btn-s" href={u.latest.url} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
              Release notes
            </a>
          )}
        </div>
        {(busy === "check" || result?.text) && (
          <p role="status" aria-live="polite" className={result?.bad ? "upd-note bad" : "upd-note"}>
            {busy === "check" ? "Checking for updates…" : result?.text}
          </p>
        )}
        {u?.newer && !u.can_update && <p className="upd-note">{u.reason}</p>}
      </section>
      <section className="set-sec">
        <h2>About</h2>
        <p>
          An open source web interface for Incus and IncusOS. Report problems on{" "}
          <a href="https://github.com/baki2001/Incus-WebUI/issues" target="_blank" rel="noreferrer">
            GitHub
          </a>
          .
        </p>
      </section>
    </>
  );
}
