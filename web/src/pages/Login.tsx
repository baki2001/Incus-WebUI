import { useRef, useState } from "react";
import { ui } from "../api";
import { Mark } from "../icons";
import { shake } from "../ui";

type Info = { setup_required: boolean; password: boolean; oidc: boolean; oidc_label?: string };

const ssoErrors: Record<string, string> = {
  sso_failed: "Single sign-on didn't complete. Try again.",
  sso_denied: "Your account isn't allowed to use this server.",
  sso_unreachable: "The sign-in provider can't be reached right now.",
};

export function Login({ info, onDone }: { info: Info; onDone: () => void }) {
  const setup = info.setup_required;
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [token, setToken] = useState("");
  const [err, setErr] = useState(() => ssoErrors[new URLSearchParams(location.search).get("error") || ""] || "");
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      if (setup) await ui("/setup", { method: "POST", body: { token: token.trim(), username: user, password: pass } });
      else await ui("/login", { method: "POST", body: { username: user, password: pass } });
      history.replaceState(null, "", "/");
      onDone();
    } catch (e: any) {
      setErr(e.message);
      shake(form.current);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <div className="login-card panel sq">
        <div className="login-brand">
          <Mark />
          <span className="brand">Incus</span>
        </div>
        <h1>{setup ? "Create your account" : "Sign in"}</h1>
        {setup && <p className="dim2">Use the setup code from the server log. This account can manage everything on the connected servers.</p>}
        {(info.password || setup) && (
          <form ref={form} onSubmit={submit} className="login-form">
            {setup && (
              <div className="fl">
                <label htmlFor="tok">Setup code</label>
                <div className="field">
                  <input id="tok" className="mono" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} autoFocus />
                </div>
              </div>
            )}
            <div className="fl">
              <label htmlFor="u">Username</label>
              <div className="field">
                <input id="u" autoComplete="username" value={user} onChange={(e) => setUser(e.target.value)} autoFocus={!setup} />
              </div>
            </div>
            <div className="fl">
              <label htmlFor="p">Password</label>
              <div className="field">
                <input id="p" type="password" autoComplete={setup ? "new-password" : "current-password"} value={pass} onChange={(e) => setPass(e.target.value)} />
              </div>
              {setup && <div className="hint">At least 10 characters.</div>}
            </div>
            {err && <div className="login-err">{err}</div>}
            <button className="btn btn-p press" disabled={busy || !user || !pass} style={{ width: "100%", height: 36 }}>
              {setup ? "Create account" : "Sign in"}
            </button>
          </form>
        )}
        {!info.password && !setup && err && <div className="login-err">{err}</div>}
        {info.oidc && (
          <>
            {info.password && <div className="login-or">or</div>}
            <a className="btn btn-s press" href="/api/ui/oidc/login" style={{ width: "100%", height: 36, textDecoration: "none" }}>
              {info.oidc_label || "Sign in with SSO"}
            </a>
          </>
        )}
      </div>
    </div>
  );
}
