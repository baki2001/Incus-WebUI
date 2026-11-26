import { useState } from "react";
import { friendlyError, ui } from "../api";
import { invalidate, useApp, useData } from "../state";
import { Field, Input, Seg, Select, TglRow, usePresence } from "../ui";

type Kind = "webhook" | "ntfy" | "discord" | "slack" | "gotify" | "email";
type Endpoint = { name: string; type: Kind; url?: string; token?: string; host?: string; port?: number; username?: string; password?: string; from?: string; to?: string };
type Conf = { endpoints: Endpoint[]; off: string[]; pool_percent: number };

const kinds: { v: Kind; l: string }[] = [
  { v: "ntfy", l: "ntfy" },
  { v: "discord", l: "Discord" },
  { v: "slack", l: "Slack" },
  { v: "gotify", l: "Gotify" },
  { v: "email", l: "E-mail" },
  { v: "webhook", l: "Webhook" },
];

const events: { k: string; title: string; note: string }[] = [
  { k: "backup", title: "Backup or test restore failed", note: "When a scheduled backup run fails, or its weekly test restore does." },
  { k: "offline", title: "Server offline", note: "When the UI can't reach a server for two checks in a row, and again when it's back." },
  { k: "pool", title: "Storage pool almost full", note: "Once per pool when it passes the limit below." },
  { k: "warning", title: "New Incus warning", note: "When Incus raises a warning it didn't have before, like a missing kernel feature or a failed network." },
  { k: "update", title: "Update available", note: "When a new version of this UI is out on the update channel you follow." },
];

const urlHints: Record<string, { label: string; hint: string; ph: string }> = {
  webhook: { label: "Address", hint: "Gets a JSON POST with kind, title, message, server and time.", ph: "https://example.com/hooks/incus" },
  ntfy: { label: "Topic address", hint: "The full address of the topic, on ntfy.sh or your own server.", ph: "https://ntfy.sh/my-incus-alerts" },
  discord: { label: "Webhook address", hint: "In Discord: channel settings, Integrations, Webhooks, Copy Webhook URL.", ph: "https://discord.com/api/webhooks/…" },
  slack: { label: "Webhook address", hint: "From a Slack app with Incoming Webhooks turned on.", ph: "https://hooks.slack.com/services/…" },
  gotify: { label: "Server address", hint: "Where your Gotify server runs.", ph: "https://gotify.lan" },
};

export function AlertSettings() {
  const app = useApp();
  const q = useData<Conf>("ui-alerts", () => ui("/alerts"));
  const [draft, setDraft] = useState<Conf | null>(null);
  const [err, setErr] = useState("");
  const [testing, setTesting] = useState("");
  const conf = draft || q.data;
  const dirty = !!draft && !!q.data && JSON.stringify(draft) !== JSON.stringify(q.data);
  const bar = usePresence(dirty || !!err);
  if (!conf) return null;
  const edit = (f: (c: Conf) => Conf) => {
    setErr("");
    setDraft(f(structuredClone(conf)));
  };
  const setE = (i: number, p: Partial<Endpoint>) => edit((c) => ((c.endpoints[i] = { ...c.endpoints[i], ...p }), c));
  const on = (k: string) => !conf.off.includes(k);
  const setOn = (k: string, v: boolean) => edit((c) => ((c.off = v ? c.off.filter((x) => x !== k) : [...c.off, k]), c));
  const save = async () => {
    try {
      await ui("/alerts", { method: "PUT", body: conf });
      app.toast("Alert settings saved");
      setDraft(null);
      invalidate("ui-alerts");
    } catch (e) {
      setErr(friendlyError(e));
    }
  };
  const test = async (e: Endpoint) => {
    setTesting(e.name);
    try {
      await ui("/alerts/test", { method: "POST", body: e });
      app.toast(`Sent a test message to ${e.name}.`);
    } catch (x) {
      app.fail(x, `${e.name} didn't take the message.`);
    } finally {
      setTesting("");
    }
  };

  return (
    <>
      <section className="set-sec">
        <h2>Where alerts go</h2>
        <p>The UI checks every five minutes and sends a short message when something needs a look. Every alert goes to each place below. Test sends one now.</p>
        <div className="col">
          {conf.endpoints.map((e, i) => (
            <div className="panel bk-card" style={{ marginBottom: 0 }} key={i}>
              <div className="two">
                <Field label="Name">
                  <Input value={e.name} onChange={(v) => setE(i, { name: v })} placeholder="phone" />
                </Field>
                <Field label="Type">
                  <Select value={e.type} onChange={(v) => setE(i, { type: v as Kind, ...(v === "email" && !e.port ? { port: 587 } : {}) })} options={kinds} />
                </Field>
                {e.type !== "email" ? (
                  <>
                    <Field label={urlHints[e.type].label} hint={urlHints[e.type].hint}>
                      <Input mono value={e.url || ""} onChange={(v) => setE(i, { url: v })} placeholder={urlHints[e.type].ph} />
                    </Field>
                    {(e.type === "ntfy" || e.type === "gotify") && (
                      <Field label={e.type === "gotify" ? "Application token" : "Access token"} hint={e.type === "gotify" ? "Make an application in Gotify and copy its token." : "Only for protected topics. Leave empty otherwise."}>
                        <Input mono type="password" value={e.token || ""} onChange={(v) => setE(i, { token: v })} />
                      </Field>
                    )}
                  </>
                ) : (
                  <>
                    <Field label="Mail server">
                      <Input mono value={e.host || ""} onChange={(v) => setE(i, { host: v })} placeholder="smtp.example.com" />
                    </Field>
                    <Field label="Port" hint="587 uses STARTTLS, 465 uses TLS from the start.">
                      <Input mono inputMode="numeric" value={e.port ? String(e.port) : ""} onChange={(v) => setE(i, { port: parseInt(v.replace(/\D/g, "")) || 0 })} placeholder="587" />
                    </Field>
                    <Field label="User name" hint="Leave empty if the server needs no sign-in.">
                      <Input mono value={e.username || ""} onChange={(v) => setE(i, { username: v })} />
                    </Field>
                    <Field label="Password">
                      <Input mono type="password" value={e.password || ""} onChange={(v) => setE(i, { password: v })} />
                    </Field>
                    <Field label="From">
                      <Input mono value={e.from || ""} onChange={(v) => setE(i, { from: v })} placeholder="incus@example.com" />
                    </Field>
                    <Field label="To" hint="Separate more addresses with commas.">
                      <Input mono value={e.to || ""} onChange={(v) => setE(i, { to: v })} placeholder="me@example.com" />
                    </Field>
                  </>
                )}
              </div>
              <div className="card-f">
                <button className="btn btn-q btn-sm" onClick={() => edit((c) => ((c.endpoints = c.endpoints.filter((_, j) => j !== i)), c))}>
                  Remove
                </button>
                <span className="r">
                  <button className="btn btn-s btn-sm press" disabled={!!testing} onClick={() => test(e)}>
                    {testing === e.name ? "Sending…" : "Test"}
                  </button>
                </span>
              </div>
            </div>
          ))}
          <div>
            <button className="btn btn-q btn-sm" onClick={() => edit((c) => (c.endpoints.push({ name: c.endpoints.length ? `alerts${c.endpoints.length + 1}` : "phone", type: "ntfy", url: "" }), c))}>
              Add a place
            </button>
          </div>
        </div>
      </section>

      <section className="set-sec">
        <h2>What to send</h2>
        <p>{conf.endpoints.length ? "Turn off what you don't want to hear about." : "Add a place above first. Until then, nothing is sent."}</p>
        <div className="tgl-list">
          {events.map((ev) => (
            <TglRow key={ev.k} title={ev.title} note={ev.k === "pool" ? `Once per pool when it passes ${conf.pool_percent}% full.` : ev.note} on={on(ev.k)} onChange={(v) => setOn(ev.k, v)} />
          ))}
        </div>
        {on("pool") && (
          <div className="fl" style={{ marginTop: 14 }}>
            <label>Pool limit</label>
            <Seg
              label="Pool limit"
              value={String(conf.pool_percent)}
              onChange={(v) => edit((c) => ((c.pool_percent = Number(v)), c))}
              options={[
                { v: "85", l: "85%" },
                { v: "90", l: "90%" },
              ]}
            />
          </div>
        )}
      </section>
      {bar.mounted && (
        <div className={"hwbar" + (bar.leaving ? " leaving" : "")}>
          {err ? <span className="bad">{err}</span> : <b>Unsaved changes</b>}
          <button className="btn btn-q btn-sm" onClick={() => (setDraft(null), setErr(""))}>
            Discard
          </button>
          <button className="btn btn-p btn-sm press" disabled={!dirty} onClick={save}>
            Save alert settings
          </button>
        </div>
      )}
    </>
  );
}
