// Hardware passthrough editor: USB devices, graphics cards and PCI cards
// from the host. Used by the instance Configuration tab and the Create sheet.
import { incus } from "../api";
import { ic } from "../icons";
import { useData } from "../state";
import type { Dev, Devs, Inherited } from "./DeviceEditors";
import "../cfg.css";

type Edit = (fn: (d: Devs) => void) => void;

// One piece of host hardware, as /1.0/resources reports it.
type HostDev = { key: string; kind: "usb" | "gpu" | "pci"; label: string; ids: string; dev: Dev };

export const hwTypes = ["usb", "unix-hotplug", "gpu", "pci"];
export const isHw = (d: Dev) => hwTypes.includes(d.type);

const hex = (s: unknown) => String(s ?? "").toLowerCase().replace(/^0x/, "").padStart(4, "0");
const name = (vendor?: string, product?: string, fallback = "Unknown device") => [vendor, product].filter(Boolean).join(" ") || fallback;

// Host bridges and similar plumbing that nobody passes through.
const plumbing = /host bridge|pci bridge|isa bridge|root port|smbus|lpc|memory controller|signal processing|sram/i;

export function hostHardware(res: any): HostDev[] {
  const out: HostDev[] = [];
  for (const u of res?.usb?.devices || []) {
    if (/hub/i.test(u.product || "")) continue;
    const vid = hex(u.vendor_id),
      pid = hex(u.product_id);
    const dev: Dev = { type: "usb", vendorid: vid, productid: pid };
    if (u.serial) dev.serial = String(u.serial);
    out.push({ key: `usb:${vid}:${pid}:${u.serial || ""}:${u.bus_address}:${u.device_address}`, kind: "usb", label: name(u.vendor, u.product), ids: `${vid}:${pid}`, dev });
  }
  const gpuAddr = new Set<string>();
  for (const g of res?.gpu?.cards || []) {
    if (!g.pci_address) continue;
    gpuAddr.add(g.pci_address);
    out.push({ key: "gpu:" + g.pci_address, kind: "gpu", label: name(g.vendor, g.product, "Graphics card"), ids: g.pci_address, dev: { type: "gpu", gputype: "physical", pci: g.pci_address } });
  }
  for (const p of res?.pci?.devices || []) {
    if (!p.pci_address || gpuAddr.has(p.pci_address) || p.driver === "pcieport" || plumbing.test(p.product || "")) continue;
    out.push({ key: "pci:" + p.pci_address, kind: "pci", label: name(p.vendor, p.product, "PCI device"), ids: p.pci_address + (p.driver ? ` · ${p.driver}` : ""), dev: { type: "pci", address: p.pci_address } });
  }
  return out;
}

const usbLike = (d: Dev) => d.type === "usb" || d.type === "unix-hotplug";

// Does device d point at host hardware h?
export function matches(d: Dev, h: HostDev): boolean {
  if (usbLike(d)) return h.kind === "usb" && hex(d.vendorid) === h.dev.vendorid && (!d.productid || hex(d.productid) === h.dev.productid) && (!d.serial || d.serial === h.dev.serial);
  if (d.type === "gpu") return h.kind === "gpu" && !!d.pci && d.pci === h.dev.pci;
  if (d.type === "pci") return h.kind === "pci" && d.address === h.dev.address;
  return false;
}

const kindLabel = (d: Dev) => (d.type === "usb" ? "USB" : d.type === "unix-hotplug" ? "USB, as /dev files" : d.type === "gpu" ? "Graphics card" : "PCI card");

// What the device does, and when it takes effect.
function noteFor(d: Dev, vm: boolean): string {
  if (d.type === "usb")
    return vm
      ? "The VM gets the whole device. Plug it in and out while it runs. The host can't use it while it is attached."
      : "Raw USB access, for programs that talk to the device directly. A USB stick or serial adapter needs /dev files instead.";
  if (d.type === "unix-hotplug") return "Shows up under /dev in the container, like /dev/sdb or /dev/ttyUSB0. Plug it in and out while it runs.";
  if (d.type === "gpu")
    return vm ? "The VM gets the whole card and the host can't use it. Needs IOMMU on in the host's firmware. Stop the VM to add or remove it." : "Shared with the host. Install the matching drivers in the container.";
  return "The VM gets the whole card and the host can't use it. Needs IOMMU on in the host's firmware. Stop the VM to add or remove it.";
}

const nextName = (d: Devs, base: string, taken: string[]) => {
  let i = 1;
  while (d[base + i] || taken.includes(base + i)) i++;
  return base + i;
};

export function HardwareEditor({
  devices,
  inherited = [],
  edit,
  server,
  vm,
  errors = {},
}: {
  devices: Devs;
  inherited?: Inherited;
  edit: Edit;
  server: string;
  vm: boolean;
  errors?: Record<string, string>;
}) {
  const res = useData<any>(server ? `resources:${server}` : null, () => incus(server, "/1.0/resources"));
  const host = hostHardware(res.data);
  const rows: [string, Dev, string | null][] = [
    ...inherited.filter(([n]) => !devices[n]).map(([n, d, p]) => [n, d, p] as [string, Dev, string | null]),
    ...Object.entries(devices).filter(([, d]) => isHw(d)).map(([n, d]) => [n, d, null] as [string, Dev, string | null]),
  ];
  const all = rows.map(([, d]) => d);
  const free = host.filter((h) => (vm || h.kind !== "pci") && !all.some((d) => matches(d, h)));
  const groups: [string, HostDev[]][] = [
    ["USB devices", free.filter((h) => h.kind === "usb")],
    ["Graphics cards", free.filter((h) => h.kind === "gpu")],
    ["Other PCI cards", free.filter((h) => h.kind === "pci")],
  ];
  const add = (key: string) => {
    const h = host.find((x) => x.key === key);
    if (!h) return;
    // A container needs /dev files for most USB devices (sticks, serial
    // adapters); a VM takes the whole device.
    const dev: Dev = h.kind === "usb" && !vm ? { type: "unix-hotplug", vendorid: h.dev.vendorid, productid: h.dev.productid } : { ...h.dev };
    edit((x) => void (x[nextName(x, h.kind, inherited.map((i) => i[0]))] = dev));
  };
  return (
    <div className="hc devl">
      {rows.length > 0 && (
        <div className="dev hw">
          <span className="hdr">Name</span>
          <span className="hdr">Device</span>
          <span className="hdr">Passed as</span>
          <span />
        </div>
      )}
      {rows.map(([n, d, from]) => {
        const dis = from != null;
        const h = host.find((x) => matches(d, x));
        const ids = usbLike(d) ? [d.vendorid, d.productid].filter(Boolean).join(":") + (d.serial ? ` · ${d.serial}` : "") : d.type === "gpu" ? d.pci || d.id || [d.vendorid, d.productid].filter(Boolean).join(":") || "any card" : d.address;
        return (
          <div key={n} data-f={"dev." + n} className="devgrp">
            <div className="dev hw">
              <div className="field mono-in">
                <input value={n} readOnly aria-label="Device name" />
              </div>
              <div className="hwname">
                <b>{h ? h.label : res.data ? "Not plugged in" : "…"}</b>
                <span className="mono dim">{ids}</span>
              </div>
              {usbLike(d) && !vm ? (
                <div className="field">
                  <select
                    aria-label={`Passed as, ${n}`}
                    disabled={dis}
                    value={d.type}
                    onChange={(e) =>
                      edit((x) => {
                        x[n] = { type: e.target.value, vendorid: d.vendorid, productid: d.productid };
                        if (e.target.value === "usb" && d.serial) x[n].serial = d.serial;
                        if (e.target.value === "usb" && !d.serial && h?.dev.serial) x[n].serial = h.dev.serial;
                      })
                    }
                  >
                    <option value="unix-hotplug">Files in /dev</option>
                    <option value="usb">Raw USB</option>
                  </select>
                </div>
              ) : (
                <span className="dim">{kindLabel(d)}</span>
              )}
              {dis ? (
                <button className="btn btn-q btn-sm" title={`From profile ${from}. Copy to this instance to edit.`} onClick={() => edit((x) => void (x[n] = { ...d }))}>
                  Edit
                </button>
              ) : (
                <button className="btn btn-q ib btn-sm" aria-label={"Remove " + n} onClick={() => edit((x) => void delete x[n])}>
                  {ic.x}
                </button>
              )}
            </div>
            {errors["dev." + n] ? (
              <span className="note bad" data-bad>
                {errors["dev." + n]}
              </span>
            ) : (
              <span className="note">{noteFor(d, vm)}</span>
            )}
            {dis && <span className="note">From profile {from}</span>}
          </div>
        );
      })}
      {errors.hw && (
        <span className="note bad" data-bad>
          {errors.hw}
        </span>
      )}
      <div className="field" style={{ width: 280 }}>
        <select aria-label="Add hardware" value="" onChange={(e) => add(e.target.value)} disabled={!res.data || free.length === 0}>
          <option value="">{res.error ? "Can't read the host's hardware" : !res.data ? "Reading the host's hardware…" : free.length ? "Add hardware…" : "No more hardware to add"}</option>
          {groups
            .filter(([, l]) => l.length)
            .map(([g, l]) => (
              <optgroup key={g} label={g}>
                {l.map((h) => (
                  <option key={h.key} value={h.key}>
                    {h.label} ({h.ids})
                  </option>
                ))}
              </optgroup>
            ))}
        </select>
      </div>
      <span className="note">{vm ? "Lists what is plugged into the host now. USB devices are matched by model and serial number, so they work in any port." : "Lists what is plugged into the host now. PCI cards only work in VMs."}</span>
    </div>
  );
}

// Returns a message per bad hardware device, keyed "dev.<name>".
// running is true for a VM that is running now; before is what the
// server has, to tell new or changed devices apart.
export function checkHardware(devices: Devs, vm: boolean, running = false, before: Devs = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [n, d] of Object.entries(devices)) {
    if (!isHw(d)) continue;
    const k = "dev." + n;
    if (usbLike(d) && !/^[0-9a-f]{4}$/i.test(d.vendorid || "")) out[k] = "Pick a USB device from the list.";
    else if (d.type === "unix-hotplug" && vm) out[k] = "A VM takes USB devices as raw USB. Remove this and add the device again.";
    else if (d.type === "pci" && !vm) out[k] = "PCI cards only work in VMs.";
    else if (d.type === "pci" && !d.address) out[k] = "Pick a PCI card from the list.";
    else if (vm && running && (d.type === "pci" || d.type === "gpu") && JSON.stringify(before[n]) !== JSON.stringify(d)) out[k] = "Stop the VM first. Incus can't add a PCI card or graphics card while it runs.";
  }
  if (vm && running)
    for (const [n, d] of Object.entries(before)) if ((d.type === "pci" || d.type === "gpu") && !devices[n]) out.hw = `Stop the VM first to remove ${n}. Incus can't remove a PCI card or graphics card while it runs.`;
  return out;
}
