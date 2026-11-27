import { useState } from "react";
import { friendlyError, incus, incusOp, ui } from "../api";
import { ic } from "../icons";
import { invalidate, useApp, useData } from "../state";
import { confirmDialog, CopyBtn, Dialog, Field, MidTrunc } from "../ui";
import { DlgForm, nameProblem } from "./InstanceDialogs";

type Member = { server_name: string; url: string; roles: string[] | null; status: string; message: string; architecture: string; failure_domain: string; groups: string[] | null; description: string };

const memberClass = (s: string) => (s === "Online" ? "running" : s === "Evacuated" ? "frozen" : "error");

// Cluster members of a clustered server, with Evacuate and Restore for maintenance.
export function ClusterPanel({ server }: { server: string }) {
  const app = useApp();
  const q = useData<Member[]>(`cluster:${server}`, () => incus(server, "/1.0/cluster/members?recursion=1"), 10000);
  const state = async (m: Member, action: "evacuate" | "restore") => {
    const ok = await confirmDialog(
      action === "evacuate"
        ? {
            title: `Evacuate ${m.server_name}?`,
            body: `Moves the instances on ${m.server_name} to other members, or stops the ones that can't move (each instance's cluster.evacuate decides). ${m.server_name} then takes no new instances, so you can update or restart it. Restore brings everything back.`,
            confirm: "Evacuate",
            danger: true,
          }
        : { title: `Restore ${m.server_name}?`, body: `Moves the instances that left ${m.server_name} back and starts the ones that were stopped there. New instances can land on it again.`, confirm: "Restore" },
    );
    if (!ok) return;
    await app.run(
      action === "evacuate" ? `Evacuating ${m.server_name}` : `Restoring ${m.server_name}`,
      (progress) => incusOp(server, `/1.0/cluster/members/${encodeURIComponent(m.server_name)}/state`, { method: "POST", body: { action } }, progress),
      action === "evacuate" ? `${m.server_name} evacuated` : `${m.server_name} restored`,
    );
    q.reload();
    invalidate("instances:");
  };
  const list = q.data || [];
  return (
    <div className="panel">
      <div className="ptitle">
        <h2>Cluster members</h2>
        <span className="r dim">{list.length || ""}</span>
      </div>
      {list.map((m) => (
        <div className="snap" key={m.server_name}>
          <div style={{ minWidth: 0 }}>
            <b style={{ fontWeight: 500 }}>{m.server_name}</b>{" "}
            <span className={"st " + memberClass(m.status)} style={{ fontSize: 12.5, marginLeft: 6 }}>
              {m.status}
            </span>
            <div className="dim" style={{ fontSize: 12.5 }}>
              <span className="mono">{m.url.replace(/^https:\/\//, "")}</span>
              {m.roles?.length ? ` · ${m.roles.join(", ")}` : ""}
              {m.groups && m.groups.filter((g) => g !== "default").length ? ` · groups ${m.groups.filter((g) => g !== "default").join(", ")}` : ""}
            </div>
            {m.message && m.message !== "Fully operational" && <div className={m.status === "Online" ? "dim" : "bad"} style={{ fontSize: 12.5 }}>{m.message}</div>}
          </div>
          {app.admin && (
            <span className="r">
              {m.status === "Evacuated" ? (
                <button className="btn btn-s btn-sm press" onClick={() => state(m, "restore")}>
                  Restore
                </button>
              ) : (
                <button className="btn btn-q btn-sm" disabled={m.status !== "Online"} onClick={() => state(m, "evacuate")}>
                  Evacuate
                </button>
              )}
            </span>
          )}
        </div>
      ))}
      {!list.length && <div className="pfoot" style={{ borderTop: 0 }}>{q.error ? friendlyError(q.error) : "Loading…"}</div>}
    </div>
  );
}

type Cert = { name: string; type: string; restricted: boolean; projects: string[] | null; fingerprint: string; description?: string };

// The clients and certificates the server trusts. Admin only.
export function TrustPanel({ server }: { server: string }) {
  const app = useApp();
  const q = useData<Cert[]>(`trust:${server}`, () => incus(server, "/1.0/certificates?recursion=1"), 30000);
  const own = useData<{ fingerprint: string }>("client-cert", () => ui("/client-cert"));
  const [adding, setAdding] = useState(false);
  const mine = (c: Cert) => !!own.data && c.fingerprint === own.data.fingerprint;
  const revoke = async (c: Cert) => {
    const ok = await confirmDialog({ title: `Revoke ${c.name}?`, body: `${c.name} can't use ${server}'s API any more. Anything signed in with this certificate is cut off right away.`, confirm: "Revoke", danger: true });
    if (!ok) return;
    await app.run(`Revoking ${c.name}`, () => incusOp(server, `/1.0/certificates/${encodeURIComponent(c.fingerprint)}`, { method: "DELETE" }), `${c.name} revoked`);
    q.reload();
  };
  const list = (q.data || []).slice().sort((a, b) => Number(mine(b)) - Number(mine(a)) || a.name.localeCompare(b.name));
  return (
    <div className="panel">
      <div className="ptitle">
        <h2>Trusted clients</h2>
        <span className="r">
          <button className="btn btn-q btn-sm" onClick={() => setAdding(true)}>
            {ic.plus}Add client
          </button>
        </span>
      </div>
      {list.map((c) => (
        <div className="snap" key={c.fingerprint}>
          <div style={{ minWidth: 0 }}>
            <b style={{ fontWeight: 500 }}>{c.name || "(no name)"}</b>
            {mine(c) && (
              <span className="tag" style={{ marginLeft: 8 }}>
                this UI
              </span>
            )}
            <div className="dim" style={{ fontSize: 12.5 }}>
              {c.type === "client" ? "Client" : c.type === "metrics" ? "Metrics only" : c.type}
              {" · "}
              {c.restricted ? `projects ${(c.projects || []).join(", ") || "none"}` : "all projects"}
              {" · "}
              <span className="mono">
                <MidTrunc text={c.fingerprint} max={17} />
              </span>
            </div>
          </div>
          <span className="r">
            <button className="btn btn-q btn-sm" disabled={mine(c)} title={mine(c) ? "This UI uses it. Revoking it would lock the UI out." : undefined} onClick={() => revoke(c)}>
              Revoke
            </button>
          </span>
        </div>
      ))}
      {!list.length && <div className="pfoot" style={{ borderTop: 0 }}>{q.error ? friendlyError(q.error) : q.data ? "No trusted clients." : "Loading…"}</div>}
      <AddClientDialog key={String(adding)} server={server} open={adding} taken={list.map((c) => c.name)} onClose={() => (setAdding(false), q.reload())} />
    </div>
  );
}

// AddClientDialog makes a one-time trust token for `incus remote add`.
function AddClientDialog({ server, open, taken, onClose }: { server: string; open: boolean; taken: string[]; onClose: () => void }) {
  const app = useApp();
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const bad = nameProblem(name, taken);
  if (token)
    return (
      <Dialog open={open} onClose={onClose} size="sm">
        <div className="dlg-b">
          <h2>Token for {name}</h2>
          <p>
            On the other machine, run <span className="mono">incus remote add {server} &lt;token&gt;</span> and paste this. It works once.
          </p>
          <div className="dlg-fields">
            <div className="tok">
              <textarea className="mono" readOnly rows={4} value={token} onFocus={(e) => e.target.select()} aria-label="Trust token" />
              <CopyBtn text={token} />
            </div>
          </div>
        </div>
        <div className="dlg-f">
          <button className="btn btn-p press" onClick={onClose} autoFocus>
            Done
          </button>
        </div>
      </Dialog>
    );
  return (
    <Dialog open={open} onClose={onClose} size="sm">
      <DlgForm
        title="Add a client"
        intro={`Makes a one-time token another machine uses to trust and be trusted by ${server}, like a laptop with the incus command. The client gets full access.`}
        confirm={busy ? "Making…" : "Make token"}
        disabled={!name || !!bad || busy}
        onClose={onClose}
        onSubmit={async () => {
          setBusy(true);
          try {
            const op = await incus<{ metadata: { fingerprint: string; addresses: string[]; secret: string; expires_at?: string } }>(server, "/1.0/certificates", { method: "POST", body: { name, type: "client", token: true } });
            const m = op.metadata;
            setToken(btoa(JSON.stringify({ client_name: name, fingerprint: m.fingerprint, addresses: m.addresses, secret: m.secret, expires_at: m.expires_at || "0001-01-01T00:00:00Z" })));
          } catch (e) {
            app.fail(e, "Couldn't make the token.");
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Name" hint={bad || "Shown in this list, like laptop."} bad={!!bad}>
          <div className="field">
            <input autoFocus value={name} onChange={(e) => setName(e.target.value.trim())} placeholder="laptop" />
          </div>
        </Field>
      </DlgForm>
    </Dialog>
  );
}
