import { useRef, useState } from "react";
import { ui } from "../api";
import { Mark } from "../icons";
import { Field, shake } from "../ui";
import { passkeyBlocker, signInWithPasskey } from "../passkey";

type Info = { setup_required: boolean; password: boolean; oidc: boolean; oidc_label?: string; passkeys?: boolean };

const ssoErrors: Record<string, string> = {
  sso_failed: "Single sign-on didn't complete. Try again.",
  sso_denied: "Your account isn't allowed to use this server.",
  sso_unreachable: "The sign-in provider can't be reached right now.",
};

const NEXT_KEY = "iwui.next";

// The page the person asked for, as a same-origin path. Anything else becomes "/".
export function safeNext(p: string | null | undefined): string {
  if (!p || !p.startsWith("/") || p.startsWith("//") || p.startsWith("/\\") || /[\u0000-\u001f]/.test(p)) return "/";
  if (p === "/login" || p.startsWith("/api/")) return "/";
  return p;
}

function wanted(): string {
  const q = new URLSearchParams(location.search);
  q.delete("error");
  const qs = q.toString();
  return safeNext(location.pathname + (qs ? "?" + qs : "") + location.hash);
}

function rememberNext() {
  try {
    sessionStorage.setItem(NEXT_KEY, wanted());
  } catch {
    /* ignore */
  }
}

export function takeNext(): string | null {
  try {
    const n = sessionStorage.getItem(NEXT_KEY);
    sessionStorage.removeItem(NEXT_KEY);
    return n ? safeNext(n) : null;
  } catch {
    return null;
  }
}

export function Login({ info, onDone }: { info: Info; onDone: () => void }) {
  const setup = info.setup_required;
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [token, setToken] = useState("");
  const [err, setErr] = useState(() => ssoErrors[new URLSearchParams(location.search).get("error") || ""] || "");
  const [busy, setBusy] = useState(false);
  // After a right password, an account with two-factor sign-in asks for a code.
  const [needCode, setNeedCode] = useState(false);
  const [code, setCode] = useState("");
  const form = useRef<HTMLFormElement>(null);
  const showPasskey = !setup && info.passkeys && !passkeyBlocker();

  const finish = () => {
    takeNext(); // drop any leftover single sign-on target
    history.replaceState(null, "", wanted());
    onDone();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      if (setup) await ui("/setup", { method: "POST", body: { token: token.trim(), username: user, password: pass } });
      else {
        const r = await ui<{ totp_required?: boolean }>("/login", { method: "POST", body: { username: user, password: pass, code: needCode ? code : "" } });
        if (r?.totp_required) {
          setNeedCode(true);
          return;
        }
      }
      finish();
    } catch (e: any) {
      setErr(e.message);
      if (needCode) setCode("");
      shake(form.current);
    } finally {
      setBusy(false);
    }
  };

  const passkey = async () => {
    setBusy(true);
    setErr("");
    try {
      await signInWithPasskey();
      finish();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const back = () => {
    setNeedCode(false);
    setCode("");
    setPass("");
    setErr("");
  };

  if (needCode)
    return (
      <div className="login">
        <div className="login-card panel sq">
          <div className="login-brand">
            <Mark />
            <span className="brand">Incus</span>
          </div>
          <h1>Enter your code</h1>
          <p className="dim">Open your authenticator app and enter the 6-digit code for {user}. Lost your phone? Enter one of your recovery codes.</p>
          <form ref={form} onSubmit={submit} className="login-form">
            <Field label="Code">
              <div className="field">
                <input className="mono" inputMode="text" autoComplete="one-time-code" autoCapitalize="off" spellCheck={false} maxLength={16} value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
              </div>
            </Field>
            {err && <div className="login-err">{err}</div>}
            <button className="btn btn-p press" disabled={busy || code.trim().length < 6}>
              Verify
            </button>
            <button type="button" className="btn btn-q btn-sm" style={{ alignSelf: "flex-start", width: "auto" }} onClick={back}>
              Back
            </button>
          </form>
        </div>
      </div>
    );

  return (
    <div className="login">
      <div className="login-card panel sq">
        <div className="login-brand">
          <Mark />
          <span className="brand">Incus</span>
        </div>
        <h1>{setup ? "Create your account" : "Sign in"}</h1>
        {setup && <p className="dim">Use the setup code from the server log. This account can manage everything on the connected servers.</p>}
        {(info.password || setup) && (
          <form ref={form} onSubmit={submit} className="login-form">
            {setup && (
              <Field label="Setup code">
                <div className="field">
                  <input className="mono" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} autoFocus />
                </div>
              </Field>
            )}
            <Field label="Username">
              <div className="field">
                <input autoComplete="username" value={user} onChange={(e) => setUser(e.target.value)} autoFocus={!setup} />
              </div>
            </Field>
            <Field label="Password" hint={setup ? "At least 10 characters." : undefined}>
              <div className="field">
                <input type="password" autoComplete={setup ? "new-password" : "current-password"} value={pass} onChange={(e) => setPass(e.target.value)} />
              </div>
            </Field>
            {err && <div className="login-err">{err}</div>}
            <button className="btn btn-p press" disabled={busy || !user || !pass}>
              {setup ? "Create account" : "Sign in"}
            </button>
          </form>
        )}
        {!info.password && !setup && err && <div className="login-err">{err}</div>}
        {showPasskey && (
          <>
            {info.password && <div className="login-or">or</div>}
            <button type="button" className="btn btn-s press" disabled={busy} onClick={passkey}>
              Sign in with a passkey
            </button>
          </>
        )}
        {info.oidc && (
          <>
            {(info.password || showPasskey) && <div className="login-or">or</div>}
            <a className="btn btn-s press" href="/api/ui/oidc/login" onClick={rememberNext} style={{ textDecoration: "none" }}>
              {info.oidc_label || "Sign in with SSO"}
            </a>
          </>
        )}
      </div>
    </div>
  );
}
