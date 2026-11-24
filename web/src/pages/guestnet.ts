// Fixed addresses for network cards on the LAN, set inside the guest the way
// Proxmox does it. Incus can only hand out a fixed address on its own bridges;
// on a host bridge or macvlan the guest configures itself. So the UI keeps the
// wanted address in user.incus-webui.ip.<card> and writes it into the guest:
// containers get their own network file (netplan, ifupdown or
// systemd-networkd), VMs get cloud-init.network-config.
import { ApiError, incusRaw } from "../api";

export const ipKey = (dev: string) => `user.incus-webui.ip.${dev}`;
export const MARK = "# Written by Incus WebUI. Change the address in the UI, not here.";

export type FixedIP = { address: string; gateway: string; dns: string };

export function parseFixed(v: string | undefined): FixedIP | null {
  if (!v) return null;
  const f: FixedIP = { address: "", gateway: "", dns: "" };
  for (const part of v.trim().split(/\s+/)) {
    const [k, val = ""] = part.split("=");
    if (k === "address" || k === "gateway" || k === "dns") f[k] = val;
  }
  return f;
}

export const formatFixed = (f: FixedIP) => [`address=${f.address}`, f.gateway && `gateway=${f.gateway}`, f.dns && `dns=${f.dns}`].filter(Boolean).join(" ");

const ip4 = (s: string) => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s.trim());
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.every((x) => x <= 255) ? ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0 : null;
};
const dnsList = (s: string) => s.split(/[,\s]+/).filter(Boolean);

export function fixedError(f: FixedIP): string | undefined {
  const m = /^([\d.]+)\/(\d{1,2})$/.exec(f.address.trim());
  if (!m || ip4(m[1]) == null || Number(m[2]) < 1 || Number(m[2]) > 32) return "Enter the address with its prefix, like 192.168.1.50/24.";
  if (f.gateway) {
    const g = ip4(f.gateway);
    if (g == null) return "Enter the gateway as an address, like 192.168.1.1.";
    const bits = Number(m[2]);
    const mask = bits === 32 ? ~0 >>> 0 : (~0 << (32 - bits)) >>> 0;
    if (((g & mask) >>> 0) !== ((ip4(m[1])! & mask) >>> 0)) return `The gateway ${f.gateway} is outside ${m[1]}/${bits}.`;
  }
  if (dnsList(f.dns).some((d) => ip4(d) == null)) return "Enter DNS servers as addresses, separated by commas.";
}

// ---------- file contents ----------

export function netplanFile(iface: string, f: FixedIP) {
  const lines = [MARK, "network:", "  version: 2", "  ethernets:", `    ${iface}:`, "      dhcp4: false", `      addresses: [${f.address}]`];
  if (f.gateway) lines.push(`      routes: [{to: default, via: ${f.gateway}}]`);
  if (f.dns) lines.push(`      nameservers: {addresses: [${dnsList(f.dns).join(", ")}]}`);
  return lines.join("\n") + "\n";
}

export function networkdFile(iface: string, f: FixedIP) {
  const lines = [MARK, "[Match]", `Name=${iface}`, "", "[Network]", `Address=${f.address}`];
  if (f.gateway) lines.push(`Gateway=${f.gateway}`);
  for (const d of dnsList(f.dns)) lines.push(`DNS=${d}`);
  return lines.join("\n") + "\n";
}

// Replace (or add) the stanza for one interface in /etc/network/interfaces,
// keeping everything else. f null switches it back to DHCP.
export function interfacesFile(text: string, iface: string, f: FixedIP | null) {
  const lines = text.split("\n");
  const out: string[] = [];
  const stanza = f ? [`iface ${iface} inet static`, `\taddress ${f.address}`, ...(f.gateway ? [`\tgateway ${f.gateway}`] : [])] : [`iface ${iface} inet dhcp`];
  const starts = /^\s*(iface|auto|allow-|mapping|source|rename)\b/;
  let done = false;
  let auto = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (new RegExp(`^\\s*(auto|allow-hotplug)\\s+(.*\\s)?${iface}(\\s|$)`).test(l)) auto = true;
    if (new RegExp(`^\\s*iface\\s+${iface}\\s+inet\\s`).test(l)) {
      if (!done) out.push(...stanza);
      done = true;
      while (i + 1 < lines.length && !starts.test(lines[i + 1]) && lines[i + 1].trim() !== "") i++;
      continue;
    }
    out.push(l);
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  if (!done) out.push("", ...(auto ? [] : [`auto ${iface}`]), ...stanza);
  else if (!auto) out.splice(out.findIndex((l) => l.startsWith(`iface ${iface} inet`)), 0, `auto ${iface}`);
  return out.join("\n") + "\n";
}

export function cloudInitNet(cards: { iface: string; f: FixedIP | null }[]) {
  const lines = [MARK, "network:", "  version: 2", "  ethernets:"];
  for (const { iface, f } of cards) {
    lines.push(`    ${iface}:`);
    if (!f) {
      lines.push("      dhcp4: true");
      continue;
    }
    lines.push("      dhcp4: false", `      addresses: [${f.address}]`);
    if (f.gateway) lines.push(`      routes: [{to: default, via: ${f.gateway}}]`);
    if (f.dns) lines.push(`      nameservers: {addresses: [${dnsList(f.dns).join(", ")}]}`);
  }
  return lines.join("\n") + "\n";
}

// ---------- writing into a container ----------

type Target = { server: string; project: string; name: string };
const fpath = (t: Target, p: string) => `/1.0/instances/${encodeURIComponent(t.name)}/files?path=${encodeURIComponent(p)}`;

async function getFile(t: Target, p: string): Promise<{ type: string; text: string } | null> {
  const r = await incusRaw(t.server, fpath(t, p), { project: t.project });
  if (r.status === 404) return null;
  if (!r.ok) throw new ApiError(r.status, `Couldn't read ${p} in ${t.name}`);
  const type = r.headers.get("X-Incus-Type") || "file";
  return { type, text: type === "file" ? await r.text() : "" };
}

async function putFile(t: Target, p: string, text: string, mode = "0644") {
  const r = await incusRaw(t.server, fpath(t, p), { method: "POST", project: t.project, raw: text, headers: { "Content-Type": "application/octet-stream", "X-Incus-type": "file", "X-Incus-mode": mode, "X-Incus-uid": "0", "X-Incus-gid": "0", "X-Incus-write": "overwrite" } });
  if (!r.ok) throw new ApiError(r.status, `Couldn't write ${p} in ${t.name}`);
}

async function delFile(t: Target, p: string) {
  const r = await incusRaw(t.server, fpath(t, p), { method: "DELETE", project: t.project });
  if (!r.ok && r.status !== 404) throw new ApiError(r.status, `Couldn't remove ${p} in ${t.name}`);
}

// Writes one card's address into a container. Returns which file it used.
export async function writeContainerNet(t: Target, iface: string, f: FixedIP | null): Promise<string> {
  const safe = iface.replace(/[^\w.-]/g, "");
  if (await getFile(t, "/etc/netplan")) {
    const p = `/etc/netplan/90-incus-webui-${safe}.yaml`;
    if (f) await putFile(t, p, netplanFile(iface, f), "0600");
    else await delFile(t, p);
    return p;
  }
  const ifs = await getFile(t, "/etc/network/interfaces");
  const networkd = await getFile(t, "/etc/systemd/network");
  if (ifs && (new RegExp(`^\\s*iface\\s+${iface}\\s`, "m").test(ifs.text) || !networkd)) {
    await putFile(t, "/etc/network/interfaces", interfacesFile(ifs.text, iface, f));
    if (f?.dns) await putFile(t, "/etc/resolv.conf", MARK + "\n" + dnsList(f.dns).map((d) => `nameserver ${d}`).join("\n") + "\n");
    return "/etc/network/interfaces";
  }
  if (networkd) {
    const p = `/etc/systemd/network/10-incus-webui-${safe}.network`;
    if (f) await putFile(t, p, networkdFile(iface, f));
    else await delFile(t, p);
    return p;
  }
  throw new Error(`Couldn't tell how ${t.name} sets up its network (no netplan, /etc/network/interfaces or systemd-networkd). Set the address inside the instance.`);
}
