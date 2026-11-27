import { useState } from "react";
import YAML from "yaml";
import { friendlyError, ui } from "../api";
import { invalidate, useApp, useData } from "../state";
import { confirmDialog, Field, MidTrunc } from "../ui";

export type SSHKey = { name: string; key: string };

export function useSSHKeys(on = true) {
  return useData<SSHKey[]>(on ? "ui-ssh-keys" : null, async () => (await ui<{ ssh_keys?: SSHKey[] }>("/prefs")).ssh_keys || []);
}

const saveKeys = (keys: SSHKey[]) => ui("/prefs", { method: "PUT", body: { ssh_keys: keys } }).then(() => invalidate("ui-ssh-keys"));

const KEY_RE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+={0,3}( .*)?$/;

// keyType is the short name of a key's algorithm, for the list.
const keyType = (k: string) => ({ "ssh-ed25519": "ED25519", "ssh-rsa": "RSA" })[k.split(" ")[0]] || k.split(" ")[0].replace(/^ecdsa-sha2-nist/, "ECDSA ").replace(/^sk-.*/, "Security key");

export function SSHKeySettings() {
  const app = useApp();
  const q = useSSHKeys();
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const keys = q.data || [];
  const clean = key.trim().replace(/\s+/g, " ");
  const comment = clean.split(" ")[2] || "";
  const taken = keys.some((k) => k.name === (name.trim() || comment));
  const bad = clean !== "" && !KEY_RE.test(clean);
  const add = async () => {
    setBusy(true);
    setErr("");
    const n = name.trim() || comment || `key${keys.length + 1}`;
    try {
      await saveKeys([...keys, { name: n, key: clean }]);
      setName("");
      setKey("");
      app.toast(`Saved ${n}`);
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (k: SSHKey) => {
    if (!(await confirmDialog({ title: `Remove ${k.name}?`, body: "New instances won't get this key any more. Instances that have it already keep it.", confirm: "Remove", danger: true }))) return;
    try {
      await saveKeys(keys.filter((x) => x !== k));
    } catch (e) {
      app.fail(e, "Couldn't remove the key.");
    }
  };
  return (
    <>
      <section className="set-sec">
        <h2>Your SSH keys</h2>
        <p>Public keys you can add to a new instance with one tick under Create instance, Cloud-init. Only you see them.</p>
        <div className="panel">
          {keys.map((k) => (
            <div className="snap" key={k.name}>
              <div style={{ minWidth: 0 }}>
                <b style={{ fontWeight: 500 }}>{k.name}</b>
                <div className="dim mono" style={{ fontSize: 12 }}>
                  {keyType(k.key)} · <MidTrunc text={k.key.split(" ")[1] || ""} max={36} />
                </div>
              </div>
              <span className="r">
                <button className="btn btn-q btn-sm" onClick={() => remove(k)}>
                  Remove
                </button>
              </span>
            </div>
          ))}
          {!keys.length && (
            <div className="pfoot" style={{ borderTop: 0 }}>
              {q.data ? "No keys yet." : "Loading…"}
            </div>
          )}
        </div>
      </section>
      <section className="set-sec">
        <h2>Add a key</h2>
        <p>
          Paste the line from your public key file, like <span className="mono">~/.ssh/id_ed25519.pub</span>. Never the private key.
        </p>
        <div className="set-form">
          <Field label="Key" hint={bad ? "That doesn't look like an SSH public key. It starts with ssh-ed25519, ssh-rsa or ecdsa-sha2." : undefined} bad={bad}>
            <div className={"field" + (bad ? " bad" : "")}>
              <textarea className="mono" rows={3} value={key} onChange={(e) => setKey(e.target.value)} placeholder="ssh-ed25519 AAAA… me@laptop" spellCheck={false} />
            </div>
          </Field>
          <Field label="Name" hint={taken ? "You have a key with this name already." : "Leave empty to use the comment at the end of the key."} bad={taken}>
            <div className="field">
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder={comment || "laptop"} />
            </div>
          </Field>
          {err && <div className="bad">{err}</div>}
          <div>
            <button className="btn btn-s press" disabled={busy || !clean || bad || taken} onClick={add}>
              {busy ? "Saving…" : "Add key"}
            </button>
          </div>
        </div>
      </section>
    </>
  );
}

// withSSHKey adds a key to cloud-init user data, or takes it out, and keeps
// the rest as the user wrote it. It throws when the YAML can't be read.
export function withSSHKey(text: string, key: string, on: boolean): string {
  const doc = YAML.parseDocument(text.trim() ? text : "#cloud-config\n");
  if (doc.errors.length) throw new Error("Fix the cloud-init YAML first.");
  if (doc.contents && !YAML.isMap(doc.contents)) throw new Error("The cloud-init user data isn't a YAML map.");
  const cur = doc.get("ssh_authorized_keys");
  const list: string[] = YAML.isSeq(cur) ? (cur.toJSON() as unknown[]).map(String) : [];
  const next = on ? (list.includes(key) ? list : [...list, key]) : list.filter((k) => k !== key);
  if (next.length) doc.set("ssh_authorized_keys", next);
  else doc.delete("ssh_authorized_keys");
  let out = doc.toString({ lineWidth: 0 });
  if (!/^#cloud-config/.test(out)) out = "#cloud-config\n" + out;
  // An empty map prints as "{}"; leave just the header.
  return out.replace(/^(#cloud-config\n)\{\}\n?$/, "$1");
}

// hasSSHKey says whether user data lists a key already.
export function hasSSHKey(text: string, key: string) {
  try {
    const v = YAML.parse(text || "");
    return Array.isArray(v?.ssh_authorized_keys) && v.ssh_authorized_keys.includes(key);
  } catch {
    return text.includes(key);
  }
}
