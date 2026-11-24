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
// Show a value in the unit the user picked when that reads exactly (1.5 GiB
// stays 1.5 GiB, not 1536 MiB); otherwise pick the best unit.
function inUnit(value: string, unit: Unit): { text: string; unit: Unit } {
  const b = memBytes(value);
  if (b != null && b > 0) {
    const f = unit === "GiB" ? GiB : MiB;
    const t = Math.round((b / f) * 100) / 100;
    if (t > 0 && Math.round(t * f) === b) return { text: String(t), unit };
  }
  return sizeParts(value, unit);
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
      setP((old) => (value ? inUnit(value, old.unit) : { text: "", unit: old.unit }));
    }
  }, [value]);
  const emit = (text: string, unit: Unit) => {
    setP({ text, unit });
    const out = sizeOut(text, unit);
    last.current = out;
    onChange(out);
  };
  // Changing the unit keeps the size: 256 MiB becomes 0.25 GiB.
  const switchUnit = (unit: Unit) => {
    const t = p.text.trim();
    if (unit === p.unit || !/^(\d+\.?\d*|\.\d+)$/.test(t) || Number(t) <= 0) return emit(p.text, unit);
    const bytes = Math.round(Number(t) * (p.unit === "GiB" ? GiB : MiB));
    setP({ text: String(Math.round((bytes / (unit === "GiB" ? GiB : MiB)) * 10000) / 10000), unit });
    const out = memStr(bytes);
    last.current = out;
    onChange(out);
  };
  return (
    <div className="unit">
      <div className={"field" + (bad ? " bad" : "")}>
        <input inputMode="decimal" aria-label={label} value={p.text} placeholder={placeholder} onChange={(e) => emit(e.target.value, p.unit)} />
      </div>
      <div className="field" style={{ width: 84 }}>
        <select aria-label={(label || "Size") + " unit"} value={p.unit} onChange={(e) => switchUnit(e.target.value as Unit)}>
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

// ---------- Network cards ----------

type NetRow = { name: string; type: string; managed: boolean; config?: Record<string, string> };

// Host interfaces an instance can use to sit on the host's own LAN.
export const lanParents = (nets: NetRow[] | undefined) => (nets || []).filter((n) => !n.managed && ["physical", "bridge", "bond", "vlan"].includes(n.type));

// A card on the LAN through a host interface: a host bridge is shared with
// "bridged" (the host can reach the instance), anything else goes through
// macvlan (the host itself can't reach the instance).
export const lanNic = (parent: NetRow, name: string): Record<string, string> => ({ type: "nic", nictype: parent.type === "bridge" ? "bridged" : "macvlan", parent: parent.name, name });

// Incus only takes ipv4.address on a card attached to a managed bridge or OVN
// network. Anywhere else (macvlan, physical, a host bridge) the address comes
// from the LAN, and Incus rejects the key with "Invalid device option".
export function fixedIPv4Net(d: Record<string, string>, nets: NetRow[] | undefined): NetRow | null {
  if (!d.network) return null;
  const n = (nets || []).find((x) => x.name === d.network);
  return n && n.managed && (n.type === "bridge" || n.type === "ovn") ? n : null;
}

const ip4 = (s: string) => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s.trim());
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.every((x) => x <= 255) ? ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0 : null;
};

// The subnet of a managed network, like 10.49.239.0/24, or "" when unknown.
export function subnetOf(n: NetRow | null): string {
  const m = /^([\d.]+)\/(\d+)$/.exec(n?.config?.["ipv4.address"] || "");
  const a = m && ip4(m[1]);
  if (a == null || !m) return "";
  const bits = Number(m[2]);
  const net = bits === 0 ? 0 : (a & (~0 << (32 - bits))) >>> 0;
  return `${[24, 16, 8, 0].map((s) => (net >>> s) & 255).join(".")}/${bits}`;
}

// Why a card's fixed IPv4 would fail, in words, before Incus says so.
export function nicIPv4Error(d: Record<string, string>, nets: NetRow[] | undefined): string | undefined {
  const v = d["ipv4.address"];
  if (!v || !nets) return;
  const n = fixedIPv4Net(d, nets);
  if (!n) return `Incus can't give a fixed address to a card on ${d.network || d.parent || "the host network"}. Remove the address: your LAN's DHCP hands one out, and you can reserve it in your router.`;
  if (ip4(v) == null) return "Enter an IPv4 address like 10.0.0.20.";
  const sub = subnetOf(n);
  if (sub) {
    const [base, bits] = sub.split("/");
    const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
    if (((ip4(v)! & mask) >>> 0) !== ip4(base)) return `${v} is outside ${n.name} (${sub}). For an address on your own LAN, connect the card to the host network instead.`;
  }
  if (n.config?.["ipv4.dhcp"] === "false" && d["security.ipv4_filtering"] !== "true") return `${n.name} has DHCP turned off, so Incus can't hand out a fixed address. Turn DHCP on for ${n.name}, or set the address inside the instance.`;
}
