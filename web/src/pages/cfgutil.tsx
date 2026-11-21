// Small helpers shared by the Configuration tab and the Create sheet.
import { useEffect, useRef, useState } from "react";
import { incus, memBytes, memStr } from "../api";
import { useData } from "../state";

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

export const CONFLICT = "Someone else changed this while you were editing. Reload to see their change.";

export function useNetworkList(server: string, project?: string) {
  return useData<any[]>(server ? `netlist:${server}:${project || ""}` : null, async () => (await incus<any[]>(server, "/1.0/networks?recursion=1", { project })) || []);
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
