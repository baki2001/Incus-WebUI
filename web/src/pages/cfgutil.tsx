// Small helpers shared by the Configuration tab and the Create sheet.
// memStr, memBytes, friendlyError, incusWithETag, useManagedNetworks,
// useServerInfo and hasExt are local stand-ins for the shared helpers in
// api.ts/data.ts; switch to those when they land.
import { useEffect, useRef, useState } from "react";
import { ApiError, incus, incusRaw, opProgress, parseBytes, type Operation } from "../api";
import { useData } from "../state";

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

// "512MiB" / "2GiB": what Incus accepts (it rejects "0.5GiB").
export function memStr(bytes: number): string {
  if (bytes >= GiB && bytes % GiB === 0) return `${bytes / GiB}GiB`;
  return `${Math.max(1, Math.round(bytes / MiB))}MiB`;
}
export function memBytes(s: string | undefined): number | null {
  return parseBytes(s);
}

export function friendlyError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/dial tcp|no such host|i\/o timeout|connection refused|connection reset|context deadline|TLS handshake|unexpected EOF|bad gateway|lookup .* on /i.test(m)) return "Couldn't reach the server. Check the network connection and try again.";
  return m;
}

export async function incusWithETag<T>(server: string, path: string, o: { project?: string } = {}): Promise<{ data: T; etag: string }> {
  const res = await incusRaw(server, path, o);
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.type === "error") throw new ApiError(res.status, j.error || res.statusText);
  return { data: j.metadata as T, etag: res.headers.get("ETag") || "" };
}
export const CONFLICT = "Someone else changed this while you were editing. Reload to see their change.";

export function useServerInfo(server: string) {
  return useData<any>(server ? `server-info:${server}` : null, () => incus(server, "/1.0"));
}
export const hasExt = (info: any, name: string) => !!info && (info.api_extensions || []).includes(name);

export function useNetworkList(server: string, project?: string) {
  return useData<any[]>(server ? `netlist:${server}:${project || ""}` : null, async () => (await incus<any[]>(server, "/1.0/networks?recursion=1", { project })) || []);
}
export function useManagedNetworks(server: string, project?: string) {
  const q = useNetworkList(server, project);
  return { ...q, data: q.data?.filter((n) => n.managed).map((n) => ({ name: n.name as string, type: n.type as string })) };
}

type Unit = "MiB" | "GiB";

export function sizeParts(value: string, defUnit: Unit): { text: string; unit: Unit } {
  const b = memBytes(value);
  if (b != null && b > 0) {
    if (b % GiB === 0) return { text: String(b / GiB), unit: "GiB" };
    return { text: String(Math.round((b / MiB) * 100) / 100), unit: "MiB" };
  }
  const m = /^\s*(.*?)\s*([KMGT]i?B)?\s*$/i.exec(value || "");
  const u = (m?.[2] || "").toLowerCase();
  return { text: m?.[1] ?? "", unit: u === "mib" || u === "mb" ? "MiB" : u === "gib" || u === "gb" ? "GiB" : defUnit };
}
function sizeOut(text: string, unit: Unit): string {
  const t = text.trim();
  if (!t) return "";
  if (/^(\d+\.?\d*|\.\d+)$/.test(t) && Number(t) > 0) return memStr(Math.round(Number(t) * (unit === "GiB" ? GiB : MiB)));
  return t + unit;
}

// Size input: a number plus MiB or GiB. Emits "512MiB" / "2GiB" (what Incus
// accepts), or the raw text when it is not a valid size so the caller can
// mark the field.
export function SizeField({ value, onChange, defUnit = "GiB", placeholder, bad, label }: { value: string; onChange: (v: string) => void; defUnit?: Unit; placeholder?: string; bad?: boolean; label?: string }) {
  const [p, setP] = useState(() => sizeParts(value, defUnit));
  const last = useRef(value);
  useEffect(() => {
    if (value !== last.current) {
      last.current = value;
      setP((old) => (value ? sizeParts(value, old.unit) : { text: "", unit: old.unit }));
    }
  }, [value]);
  const emit = (text: string, unit: Unit) => {
    setP({ text, unit });
    const out = sizeOut(text, unit);
    last.current = out;
    onChange(out);
  };
  return (
    <div className="unit">
      <div className={"field" + (bad ? " bad" : "")}>
        <input inputMode="decimal" aria-label={label} value={p.text} placeholder={placeholder} onChange={(e) => emit(e.target.value, p.unit)} />
      </div>
      <div className="field" style={{ width: 84 }}>
        <select aria-label={(label || "Size") + " unit"} value={p.unit} onChange={(e) => emit(p.text, e.target.value as Unit)}>
          <option>MiB</option>
          <option>GiB</option>
        </select>
      </div>
    </div>
  );
}

// Sends a request that may start an async operation and waits for it, with
// progress text. Local stand-in for incusOp: Incus answers a wait that timed
// out with no metadata, which this tolerates.
export async function runOp(server: string, path: string, o: { method?: string; body?: any; project?: string }, onProgress?: (detail: string) => void): Promise<any> {
  const res = await incusRaw(server, path, o);
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.type === "error") throw new ApiError(res.status, j.error || res.statusText);
  if (j.type !== "async") return j.metadata;
  const id = (j.metadata as Operation).id;
  for (;;) {
    const op = await incus<Operation | undefined>(server, `/1.0/operations/${id}/wait?timeout=2`, { project: o.project });
    if (op && op.status_code >= 200) {
      if (op.status_code !== 200) throw new ApiError(400, op.err || op.status);
      return op;
    }
    const cur = await incus<Operation>(server, `/1.0/operations/${id}`, { project: o.project }).catch(() => undefined);
    if (cur && cur.status_code >= 200) {
      if (cur.status_code !== 200) throw new ApiError(400, cur.err || cur.status);
      return cur;
    }
    const p = cur && opProgress(cur);
    if (p) onProgress?.(p);
  }
}

// Cores: "2", or a pin list like "0-3,6".
export const cpuOK = (s: string) => (/^\d+$/.test(s) ? Number(s) > 0 : /^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(s));
export function cpuCount(s: string): number {
  if (/^\d+$/.test(s)) return Number(s);
  let n = 0;
  for (const part of s.split(",")) {
    const [a, b] = part.split("-").map(Number);
    n += b != null ? Math.max(0, b - a + 1) : 1;
  }
  return n;
}
export const portOK = (s: string) => /^\d+$/.test(s) && Number(s) >= 1 && Number(s) <= 65535;
export const portsOK = (s: string) => /^\d+(-\d+)?$/.test(s) && s.split("-").every(portOK);
