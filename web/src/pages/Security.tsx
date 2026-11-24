import { useRef, useState } from "react";
import { ui } from "../api";
import { ic } from "../icons";
import { addPasskey, guessPasskeyName, passkeyBlocker } from "../passkey";
import { invalidate, useApp, useData } from "../state";
import { confirmDialog, CopyBtn, Field, shake, Skel } from "../ui";

type PasskeyRow = { id: string; name: string; created: number; last_used?: number };
type SecurityInfo = { totp: boolean; recovery_left: number; passkeys: PasskeyRow[] };

const KEY = "ui-security";
const day = (t?: number) => (t ? new Date(t * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "");

// Security is the signed-in local user's own two-factor sign-in and passkeys.
export function Security() {
  const q = useData<SecurityInfo>(KEY, () => ui("/account/security"));
  const [codes, setCodes] = useState<string[] | null>(null);
  if (codes) return <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />;
  return (
    <>
      <TwoFactor info={q.data} onCodes={setCodes} />
      <Passkeys info={q.data} />
    </>
  );
}

function TwoFactor({ info, onCodes }: { info?: SecurityInfo; onCodes: (c: string[]) => void }) {
  const app = useApp();
  const [setup, setSetup] = useState<{ secret: string; uri: string; qr?: string } | null>(null);
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<null | "off" | "codes">(null);
  const [pass, setPass] = useState("");
  const formRef = useRef<HTMLFormElement>(null);

  const start = async () => {
    setErr("");
    try {
      setSetup(await ui("/account/totp/setup", { method: "POST" }));
      setCode("");
    } catch (e: any) {
      app.fail(e, "Could not start the setup.");
    }
  };
  const enable = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!setup) return;
    setBusy(true);
    setErr("");
    try {
      const r = await ui<{ recovery_codes: string[] }>("/account/totp", { method: "POST", body: { secret: setup.secret, code } });
      setSetup(null);
      invalidate(KEY);
      app.toast("Two-factor sign-in is on");
      onCodes(r.recovery_codes);
    } catch (e: any) {
      setErr(e.message);
      shake(formRef.current);
    } finally {
      setBusy(false);
    }
  };
  const withPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      if (confirm === "off") {
        await ui("/account/totp/disable", { method: "POST", body: { password: pass } });
        app.toast("Two-factor sign-in is off");
      } else {
        const r = await ui<{ recovery_codes: string[] }>("/account/recovery-codes", { method: "POST", body: { password: pass } });
        onCodes(r.recovery_codes);
      }
      setConfirm(null);
      setPass("");
      invalidate(KEY);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="set-sec">
      <h2>Two-factor sign-in</h2>
      {!info ? (
        <Skel lines={2} />
      ) : info.totp ? (
        <p>
          On. After your password, you enter a code from your authenticator app. {info.recovery_left === 1 ? "1 recovery code" : `${info.recovery_left} recovery codes`} left.
        </p>
      ) : (
        <p>Off. Turn it on to also ask for a 6-digit code from an authenticator app, such as 1Password, Aegis or Google Authenticator, after your password.</p>
      )}

      {info && !info.totp && !setup && (
        <div>
          <button className="btn btn-p press" onClick={start}>
            Set up two-factor sign-in
          </button>
        </div>
      )}

      {setup && (
        <form ref={formRef} className="panel sec-setup" onSubmit={enable}>
          <div className="sec-qr">{setup.qr ? <img src={setup.qr} alt="QR code to scan with your authenticator app" width={180} height={180} /> : null}</div>
          <div className="sec-steps">
            <ol>
              <li>Scan the QR code with your authenticator app.</li>
              <li>
                Can't scan it? Enter this key instead:
                <div className="sec-key">
                  <span className="mono">{setup.secret.replace(/(.{4})/g, "$1 ").trim()}</span>
                  <CopyBtn text={setup.secret} />
                </div>
              </li>
              <li>Enter the 6-digit code the app shows.</li>
            </ol>
            <Field label="Code">
              <div className="field" style={{ maxWidth: 160 }}>
                <input className="mono" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} autoFocus />
              </div>
            </Field>
            {err && <div className="bad">{err}</div>}
            <div className="sec-btns">
              <button className="btn btn-p press" disabled={busy || code.length !== 6}>
                Turn on
              </button>
              <button type="button" className="btn btn-q" onClick={() => setSetup(null)}>
                Cancel
              </button>
            </div>
          </div>
        </form>
      )}

      {info?.totp && !confirm && (
        <div className="sec-btns">
          <button className="btn btn-s press" onClick={() => setConfirm("codes")}>
            New recovery codes
          </button>
          <button className="btn btn-q press" onClick={() => setConfirm("off")}>
            Turn off
          </button>
        </div>
      )}

      {confirm && (
        <form className="set-form" style={{ maxWidth: 420 }} onSubmit={withPassword}>
          <Field label="Your password" hint={confirm === "off" ? "Needed to turn off two-factor sign-in." : "Needed to make new recovery codes. The old ones stop working."}>
            <div className="field">
              <input type="password" autoComplete="current-password" value={pass} onChange={(e) => setPass(e.target.value)} autoFocus />
            </div>
          </Field>
          {err && <div className="bad">{err}</div>}
          <div className="sec-btns">
            <button className={"btn press " + (confirm === "off" ? "btn-d" : "btn-s")} disabled={busy || !pass}>
              {confirm === "off" ? "Turn off" : "Make new codes"}
            </button>
            <button
              type="button"
              className="btn btn-q"
              onClick={() => {
                setConfirm(null);
                setPass("");
                setErr("");
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const app = useApp();
  const text = codes.join("\n");
  const download = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([`Incus recovery codes for ${location.host}\nEach code works once.\n\n${text}\n`], { type: "text/plain" }));
    a.download = "incus-recovery-codes.txt";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  return (
    <section className="set-sec">
      <h2>Save your recovery codes</h2>
      <p>If you lose your phone, sign in with one of these instead of a code. Each works once. They won't be shown again, so keep them somewhere safe, like your password manager.</p>
      <div className="set-form" style={{ maxWidth: 420 }}>
        <div className="sec-grid mono">
          {codes.map((c) => (
            <span key={c}>{c}</span>
          ))}
        </div>
        <div className="sec-btns">
          <button type="button" className="btn btn-s btn-sm press" onClick={() => navigator.clipboard?.writeText(text).then(() => app.toast("Copied"))}>
            {ic.copy}Copy
          </button>
          <button type="button" className="btn btn-s btn-sm press" onClick={download}>
            Download
          </button>
        </div>
      </div>
      <div className="sec-btns" style={{ marginTop: 14 }}>
        <button className="btn btn-p press" onClick={onDone}>
          I've saved them
        </button>
      </div>
    </section>
  );
}

function Passkeys({ info }: { info?: SecurityInfo }) {
  const app = useApp();
  const [name, setName] = useState(guessPasskeyName);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [edit, setEdit] = useState<{ id: string; name: string } | null>(null);
  const blocker = passkeyBlocker();
  const keys = info?.passkeys || [];

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      await addPasskey(name.trim());
      invalidate(KEY);
      app.toast(`Passkey ${name.trim() || "Passkey"} added`);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (k: PasskeyRow) => {
    if (!(await confirmDialog({ title: `Remove ${k.name}?`, body: "You can't sign in with this passkey any more. Also remove it from the device or password manager that holds it.", confirm: "Remove", danger: true }))) return;
    try {
      await ui(`/account/passkeys/${encodeURIComponent(k.id)}`, { method: "DELETE" });
      invalidate(KEY);
    } catch (e: any) {
      app.fail(e, "Could not remove the passkey.");
    }
  };
  const rename = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!edit) return;
    try {
      await ui(`/account/passkeys/${encodeURIComponent(edit.id)}`, { method: "PUT", body: { name: edit.name } });
      setEdit(null);
      invalidate(KEY);
    } catch (e: any) {
      app.fail(e, "Could not rename the passkey.");
    }
  };

  return (
    <section className="set-sec">
      <h2>Passkeys</h2>
      <p>Sign in with your fingerprint, face or device PIN instead of your password and code. Your password keeps working too.</p>
      {keys.length > 0 && (
        <div className="panel" style={{ marginBottom: 14 }}>
          {keys.map((k) => (
            <div className="prow" key={k.id}>
              {edit?.id === k.id ? (
                <form onSubmit={rename} style={{ display: "flex", gap: 8, flex: 1, flexWrap: "wrap" }}>
                  <div className="field" style={{ flex: "1 1 180px" }}>
                    <input aria-label="Passkey name" value={edit.name} maxLength={64} onChange={(e) => setEdit({ ...edit, name: e.target.value })} autoFocus />
                  </div>
                  <button className="btn btn-s btn-sm press" disabled={!edit.name.trim()}>
                    Save
                  </button>
                  <button type="button" className="btn btn-q btn-sm" onClick={() => setEdit(null)}>
                    Cancel
                  </button>
                </form>
              ) : (
                <>
                  <div style={{ minWidth: 0 }}>
                    <b style={{ fontWeight: 500 }}>{k.name}</b>
                    <div className="dim" style={{ fontSize: 12.5 }}>
                      Added {day(k.created)}
                      {k.last_used ? ` · Last used ${day(k.last_used)}` : " · Not used yet"}
                    </div>
                  </div>
                  <span className="r">
                    <button className="btn btn-q btn-sm" onClick={() => setEdit({ id: k.id, name: k.name })}>
                      Rename
                    </button>
                    <button className="btn btn-q btn-sm" onClick={() => remove(k)}>
                      Remove
                    </button>
                  </span>
                </>
              )}
            </div>
          ))}
        </div>
      )}
      {blocker ? (
        <p className="sec-note">{blocker}</p>
      ) : (
        <form className="sec-add" onSubmit={add}>
          <Field label="Name" hint="So you can tell your passkeys apart.">
            <div className="field">
              <input value={name} maxLength={64} onChange={(e) => setName(e.target.value)} />
            </div>
          </Field>
          <div className="fl">
            <button className="btn btn-s press" disabled={busy}>
              {busy ? "Waiting for your device…" : "Add a passkey"}
            </button>
            <div className="hint" />
          </div>
          {err && <div className="bad" style={{ flexBasis: "100%" }}>{err}</div>}
        </form>
      )}
    </section>
  );
}
