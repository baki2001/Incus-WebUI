// Browser side of passkeys (WebAuthn). The server sends options as JSON with
// binary fields in base64url; the browser API wants ArrayBuffers.

import { ui } from "./api";

export const passkeysSupported = () => typeof window !== "undefined" && !!window.PublicKeyCredential && !!navigator.credentials;

// Why passkeys can't work on this page, or "" when they can.
export function passkeyBlocker(): string {
  if (!passkeysSupported()) return "This browser doesn't support passkeys.";
  if (!window.isSecureContext) return "Passkeys need the UI to be opened over HTTPS.";
  const h = location.hostname;
  if (/^[\d.]+$/.test(h) || h.includes(":")) return "Passkeys need the UI to be opened by a domain name, not an IP address.";
  return "";
}

const fromB64 = (s: string): ArrayBuffer => {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out.buffer;
};

const toB64 = (buf: ArrayBuffer | null | undefined): string | undefined => {
  if (!buf) return undefined;
  let s = "";
  for (const c of new Uint8Array(buf)) s += String.fromCharCode(c);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const ids = (list: any[] | undefined) => list?.map((c) => ({ ...c, id: fromB64(c.id) }));

function creationOptions(pk: any): CredentialCreationOptions {
  return { publicKey: { ...pk, challenge: fromB64(pk.challenge), user: { ...pk.user, id: fromB64(pk.user.id) }, excludeCredentials: ids(pk.excludeCredentials) } };
}

function requestOptions(pk: any): CredentialRequestOptions {
  return { publicKey: { ...pk, challenge: fromB64(pk.challenge), allowCredentials: ids(pk.allowCredentials) } };
}

function credJSON(c: PublicKeyCredential): any {
  const r = c.response as AuthenticatorAttestationResponse & AuthenticatorAssertionResponse;
  return {
    id: c.id,
    rawId: toB64(c.rawId),
    type: c.type,
    authenticatorAttachment: c.authenticatorAttachment ?? undefined,
    clientExtensionResults: c.getClientExtensionResults(),
    response: {
      clientDataJSON: toB64(r.clientDataJSON),
      attestationObject: toB64(r.attestationObject),
      transports: typeof r.getTransports === "function" ? r.getTransports() : undefined,
      authenticatorData: toB64(r.authenticatorData),
      signature: toB64(r.signature),
      userHandle: toB64(r.userHandle),
    },
  };
}

// The browser's own messages for a cancelled or refused ceremony are cryptic.
function friendly(e: any): Error {
  if (e?.name === "NotAllowedError") return new Error("The passkey request was cancelled or timed out.");
  if (e?.name === "InvalidStateError") return new Error("This passkey is already added to your account.");
  if (e?.name === "SecurityError") return new Error("The browser refused passkeys for this address. Open the UI by its domain name over HTTPS.");
  return e instanceof Error ? e : new Error(String(e));
}

export async function addPasskey(name: string) {
  const opts = await ui<any>("/account/passkeys/begin", { method: "POST" });
  let cred: PublicKeyCredential;
  try {
    cred = (await navigator.credentials.create(creationOptions(opts.publicKey))) as PublicKeyCredential;
  } catch (e) {
    throw friendly(e);
  }
  return ui("/account/passkeys/finish", { method: "POST", body: { name, credential: credJSON(cred) } });
}

export async function signInWithPasskey() {
  const opts = await ui<any>("/passkey/login/begin", { method: "POST" });
  let cred: PublicKeyCredential;
  try {
    cred = (await navigator.credentials.get(requestOptions(opts.publicKey))) as PublicKeyCredential;
  } catch (e) {
    throw friendly(e);
  }
  return ui("/passkey/login/finish", { method: "POST", body: credJSON(cred) });
}

// A name for a new passkey, from the device it's made on.
export function guessPasskeyName(): string {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  const br = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
  return [br, os].filter(Boolean).join(" on ") || "Passkey";
}
