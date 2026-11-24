import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ui } from "../api";
import { ic } from "../icons";
import { useCrumbs } from "../Shell";
import { BackupSettings } from "./Backups";
import { Security } from "./Security";
import { accentPair, contrast, invalidate, useApp, useData, type AccessEntry, type Mode, type RoleName, type Theme } from "../state";
import { confirmDialog, CopyBtn, Field, Input, Menu, Seg, Select, usePresence, useThumb } from "../ui";

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

function Appearance() {
  const app = useApp();
  const [custom, setCustom] = useState(app.theme.accent || "#7a4fd6");
  const setTheme = async (t: Theme) => {
    const prev = app.theme;
    app.setTheme(t);
    try {
      await ui("/theme", { method: "PUT", body: t });
      app.toast(`Default look set to ${t.name[0].toUpperCase() + t.name.slice(1)}`, { label: "Undo", fn: () => setTheme(prev) });
    } catch (e: any) {
      app.setTheme(prev);
      app.fail(e, "Could not change the theme.");
    }
  };
  const pair = accentPair(custom);
  // Preview colours: page, sidebar, sidebar lines, card, card lines, button.
  type Pv = { page: string; side: string; sideInk: string; card: string; cardInk: string; btn: string };
  const themes: { v: Theme["name"]; l: string; note: string; pv: Pv }[] = [
    { v: "kyoto", l: "Kyoto", note: "Stone and indigo", pv: { page: "#ebecef", side: "#142950", sideInk: "#fff", card: "#fff", cardInk: "#101a30", btn: "#db390c" } },
    { v: "light", l: "Light", note: "Plain light", pv: { page: "#f5f5f7", side: "transparent", sideInk: "#1c1c1f", card: "#fff", cardInk: "#1c1c1f", btn: "#3d5fc4" } },
    { v: "graphite", l: "Graphite", note: "Dark", pv: { page: "#0e0e10", side: "transparent", sideInk: "rgba(255,255,255,.7)", card: "#1d1d20", cardInk: "rgba(255,255,255,.8)", btn: "#93a8ee" } },
    { v: "custom", l: "Custom", note: "Your accent", pv: { page: "#f5f5f7", side: "transparent", sideInk: "#1c1c1f", card: "#fff", cardInk: "#1c1c1f", btn: pair.light } },
  ];
  return (
    <>
      <section className="set-sec">
        <h2>
          Look<span className="scope-tag">Just for you, on this browser</span>
        </h2>
        <Seg value={app.mode} onChange={(m: Mode) => app.setMode(m)} options={[{ v: "kyoto", l: "Kyoto" }, { v: "light", l: "Light" }, { v: "graphite", l: "Graphite" }]} />
      </section>
      {app.admin && <section className="set-sec">
        <h2>
          Default look<span className="scope-tag">For everyone using this server</span>
        </h2>
        <p>What people see until they pick their own look.</p>
        <div className="tcards">
          {themes.map((t) => (
            <button key={t.v} className="tcard press" aria-pressed={app.theme.name === t.v} onClick={() => setTheme(t.v === "custom" ? { name: "custom", accent: custom } : { name: t.v })}>
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
        {app.theme.name === "custom" && (
          <div className="custom-row">
            <div className="cr">
              Accent
              <div className="row">
                <input type="color" value={custom} onChange={(e) => setCustom(e.target.value)} aria-label="Accent colour" />
                <div className="field">
                  <input className="mono" value={custom} onChange={(e) => setCustom(e.target.value)} />
                </div>
              </div>
            </div>
            <div className="cr">
              Light mode
              <div className="row">
                <span className="sw" style={{ background: pair.light }} />
                <span className="mono">{pair.light}</span>
                <span className="dim2">{contrast(pair.light, "#f5f5f7").toFixed(1)}:1</span>
              </div>
              Dark mode
              <div className="row">
                <span className="sw" style={{ background: pair.dark }} />
                <span className="mono">{pair.dark}</span>
                <span className="dim2">{contrast(pair.dark, "#0e0e10").toFixed(1)}:1</span>
              </div>
            </div>
            <div className="cr" style={{ justifyContent: "flex-end" }}>
              <span>Adjusted where needed so text stays readable.</span>
              <button className="btn btn-s btn-sm press" disabled={!/^#[0-9a-fA-F]{6}$/.test(custom) || custom === app.theme.accent} onClick={() => setTheme({ name: "custom", accent: custom })}>
                Use this colour
              </button>
            </div>
          </div>
        )}
      </section>}
    </>
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

function Users() {
  const app = useApp();
  const q = useData<{ users: { username: string; totp?: boolean; passkeys?: number }[]; oidc?: { issuer: string; allowed_emails?: string[]; allowed_groups?: string[] } }>("ui-users", () => ui("/users"));
  const [u, setU] = useState("");
  const [p, setP] = useState("");
  const [role, setRole] = useState<RoleName>("viewer");
  const [err, setErr] = useState("");
  const [pw, setPw] = useState<{ name: string; pass: string; err: string } | null>(null);
  const users = q.data?.users || [];
  const add = async () => {
    setErr("");
    try {
      await ui("/users", { method: "POST", body: { username: u, password: p, role } });
      app.toast(`${u} added as ${role}`);
      invalidate("ui-access");
      setU("");
      setP("");
      invalidate("ui-users");
    } catch (e: any) {
      setErr(e.message);
    }
  };
  const changePw = async () => {
    if (!pw) return;
    try {
      await ui(`/users/${encodeURIComponent(pw.name)}`, { method: "PUT", body: { password: pw.pass } });
      app.toast(`Password changed for ${pw.name}`);
      setPw(null);
    } catch (e: any) {
      setPw({ ...pw, err: e.message });
    }
  };
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
    if (!(await confirmDialog({ title: `Remove ${name}?`, body: "They can't sign in with a password any more.", confirm: "Remove", danger: true }))) return;
    try {
      await ui(`/users/${encodeURIComponent(name)}`, { method: "DELETE" });
      invalidate("ui-users");
      invalidate("ui-access");
    } catch (e: any) {
      app.fail(e, "Could not remove the user.");
    }
  };
  return (
    <>
      <section className="set-sec">
        <h2>Local users</h2>
        <div className="panel">
          {users.map((x) => {
            const canReset = x.username !== app.user && (x.totp || !!x.passkeys);
            const canDel = x.username !== app.user && users.length > 1;
            return (
              <div className="snap" key={x.username} style={{ flexWrap: "wrap" }}>
                <span className="av">{x.username.replace(/@.*/, "").split(/[._\s-]+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase()}</span>
                <span>
                  {x.username}
                  {x.username === app.user && <span className="dim"> · you</span>}
                  {x.totp && <span className="dim"> · 2FA</span>}
                  {!!x.passkeys && <span className="dim"> · {x.passkeys === 1 ? "1 passkey" : `${x.passkeys} passkeys`}</span>}
                </span>
                <span className="r" style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <button className="btn btn-q btn-sm" onClick={() => setPw(pw?.name === x.username ? null : { name: x.username, pass: "", err: "" })}>
                    Change password
                  </button>
                  {(canReset || canDel) && (
                    <Menu
                      button={(p) => (
                        <button className="btn btn-q ib btn-sm" aria-label={`Actions for ${x.username}`} {...p}>
                          {ic.more}
                        </button>
                      )}
                    >
                      {(close) => (
                        <>
                          {canReset && (
                            <button onClick={() => (close(), resetSignIn(x.username))}>
                              Reset 2FA and passkeys
                            </button>
                          )}
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
                {pw?.name === x.username && (
                  <form
                    style={{ flexBasis: "100%", display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end", paddingTop: 8 }}
                    onSubmit={(e) => {
                      e.preventDefault();
                      changePw();
                    }}
                  >
                    <Field label={`New password for ${x.username}`} hint="At least 10 characters.">
                      <div className="field">
                        <input type="password" autoFocus value={pw.pass} onChange={(e) => setPw({ ...pw, pass: e.target.value, err: "" })} autoComplete="new-password" />
                      </div>
                    </Field>
                    <div className="fl">
                      <button className="btn btn-s press" disabled={!pw.pass}>
                        Save
                      </button>
                      <div className="hint" />
                    </div>
                    {pw.err && <div className="bad" style={{ width: "100%" }}>{pw.err}</div>}
                  </form>
                )}
              </div>
            );
          })}
        </div>
      </section>
      <section className="set-sec">
        <h2>Add a user</h2>
        <div className="set-form">
          <Field label="Username">
            <div className="field">
              <input value={u} onChange={(e) => setU(e.target.value)} autoComplete="off" />
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
          <div>
            <button className="btn btn-s press" disabled={!u || !p} onClick={add}>
              Add user
            </button>
          </div>
          {err && <div className="bad">{err}</div>}
        </div>
      </section>
      <Roles />
      <section className="set-sec">
        <h2>
          Single sign-on <span className="ac">(OIDC)</span>
        </h2>
        {q.data?.oidc ? (
          <p>
            On, with <span className="mono">{q.data.oidc.issuer}</span>.
            {q.data.oidc.allowed_emails?.length ? ` Allowed: ${q.data.oidc.allowed_emails.join(", ")}.` : ""}
            {q.data.oidc.allowed_groups?.length ? ` Groups: ${q.data.oidc.allowed_groups.join(", ")}.` : ""}
          </p>
        ) : (
          <p>
            Off. Add an <span className="mono">oidc</span> block to <span className="mono">config.yaml</span> and restart to turn it on. The install guide shows how.
          </p>
        )}
      </section>
    </>
  );
}

const roleOptions = [
  { v: "viewer", l: "Viewer: only look" },
  { v: "operator", l: "Operator: start, stop, console, files" },
  { v: "manager", l: "Manager: create, change, delete" },
  { v: "admin", l: "Admin: everything, also users and servers" },
];

// Roles lists every access entry and saves them in one go.
function Roles() {
  const app = useApp();
  const q = useData<{ access: AccessEntry[] }>("ui-access", () => ui("/access"));
  const [rows, setRows] = useState<AccessEntry[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => setRows(q.data?.access || null), [q.data]);
  const dirty = !!rows && JSON.stringify(rows) !== JSON.stringify(q.data?.access);
  const bar = usePresence(dirty || !!err);
  if (!rows) return null;
  const set = (i: number, k: keyof AccessEntry, v: string) => {
    setErr("");
    setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v, ...(k === "role" && v === "admin" ? { server: "*", project: "*" } : {}) } : r)));
  };
  const save = async () => {
    try {
      await ui("/access", { method: "PUT", body: { access: rows } });
      app.toast("Roles saved");
      invalidate("ui-access");
    } catch (e: any) {
      setErr(e.message);
    }
  };
  const servers = ["*", ...app.servers.map((s) => s.name)];
  return (
    <section className="set-sec">
      <h2>Roles</h2>
      <p>
        Who is <span className="mono">user:name</span> for a local user, <span className="mono">sso:name</span> for a single sign-on user, <span className="mono">group:name</span> for an SSO group, or{" "}
        <span className="mono">*</span> for everyone who can sign in. Someone with several entries gets the highest role that fits.
      </p>
      <div className="panel roles">
        <div className="roles-h">
          <span>Who</span>
          <span>Server</span>
          <span>Project</span>
          <span>Role</span>
          <span />
        </div>
        {rows.map((r, i) => (
          <div className="roles-r" key={i}>
            <div>
              <span className="show-s-only dim" style={{ fontSize: 12 }}>Who</span>
              <Input mono aria-label="Who" value={r.who} onChange={(v) => set(i, "who", v)} />
            </div>
            <div>
              <span className="show-s-only dim" style={{ fontSize: 12 }}>Server</span>
              <Select aria-label="Server" disabled={r.role === "admin"} value={r.server} onChange={(v) => set(i, "server", v)} options={servers.includes(r.server) ? servers : [...servers, r.server]} />
            </div>
            <div>
              <span className="show-s-only dim" style={{ fontSize: 12 }}>Project</span>
              <Input mono aria-label="Project" disabled={r.role === "admin"} value={r.project} onChange={(v) => set(i, "project", v)} placeholder="*" />
            </div>
            <div>
              <span className="show-s-only dim" style={{ fontSize: 12 }}>Role</span>
              <Select aria-label="Role" value={r.role} onChange={(v) => set(i, "role", v)} options={roleOptions.map((o) => ({ v: o.v, l: o.v[0].toUpperCase() + o.v.slice(1) }))} />
            </div>
            <button className="btn btn-q btn-sm" aria-label={`Remove ${r.who}`} onClick={() => setRows(rows.filter((_, j) => j !== i))}>
              Remove
            </button>
          </div>
        ))}
        <div className="roles-f">
          <button className="btn btn-q btn-sm" onClick={() => setRows([...rows, { who: "user:", server: "*", project: "*", role: "viewer" }])}>
            Add entry
          </button>
        </div>
      </div>
      {bar.mounted && (
        <div className={"hwbar" + (bar.leaving ? " leaving" : "")}>
          {err ? <span className="bad">{err}</span> : <b>Unsaved role changes</b>}
          <button className="btn btn-q btn-sm" onClick={() => (setRows(q.data?.access || []), setErr(""))}>
            Discard
          </button>
          <button className="btn btn-p btn-sm press" disabled={!dirty} onClick={save}>
            Save roles
          </button>
        </div>
      )}
    </section>
  );
}

export type UpdateInfo = {
  current: string;
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
                ? "It's the newest release."
                : ""}
        </p>
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
