// Disk and port forwarding (proxy) editors, used by the instance
// Configuration tab and the Create sheet.
import { listVolumes, useServerInfo } from "../data";
import { ic } from "../icons";
import { useData } from "../state";
import { portsOK } from "./cfgutil";
import "../cfg.css";

export type Dev = Record<string, string>;
export type Devs = Record<string, Dev>;
export type Inherited = [name: string, dev: Dev, profile: string][];
type Edit = (fn: (d: Devs) => void) => void;

const nextName = (d: Devs, base: string, taken: string[] = []) => {
  let i = 1;
  while (d[base + i] || taken.includes(base + i)) i++;
  return base + i;
};

export function DiskEditor({ devices, inherited = [], edit, server, project, errors = {} }: { devices: Devs; inherited?: Inherited; edit: Edit; server: string; project: string; errors?: Record<string, string> }) {
  const vols = useData<any[]>(server ? `vols:${server}:${project}` : null, () => listVolumes(server, project));
  const custom = (vols.data || []).filter((v) => v.type === "custom" && v.content_type !== "iso");
  const pools = [...new Set((vols.data || []).map((v) => v.pool as string))];
  const rows: [string, Dev, string | null][] = [
    ...inherited.filter(([n]) => !devices[n]).map(([n, d, p]) => [n, d, p] as [string, Dev, string | null]),
    ...Object.entries(devices).filter(([n, d]) => d.type === "disk" && n !== "root").map(([n, d]) => [n, d, null] as [string, Dev, string | null]),
  ];
  return (
    <div className="hc devl">
      {rows.length > 0 && (
        <div className="dev dk">
          <span className="hdr">Name</span>
          <span className="hdr">Source</span>
          <span className="hdr">Host path, or pool and volume</span>
          <span className="hdr">Path inside</span>
          <span />
        </div>
      )}
      {rows.map(([n, d, from]) => {
        const isVol = !!d.pool && !d.source?.startsWith("/");
        const dis = from != null;
        return (
          <div key={n} data-f={"dev." + n}>
            <div className="dev dk">
              <div className="field mono-in">
                <input value={n} readOnly aria-label="Device name" />
              </div>
              <div className="field">
                <select
                  aria-label={`Source of ${n}`}
                  disabled={dis}
                  value={isVol ? "vol" : "path"}
                  onChange={(e) =>
                    edit((x) => {
                      if (e.target.value === "vol") {
                        x[n].pool = pools[0] || "default";
                        x[n].source = "";
                      } else {
                        delete x[n].pool;
                        x[n].source = "";
                      }
                    })
                  }
                >
                  <option value="path">Host path</option>
                  <option value="vol">Storage volume</option>
                </select>
              </div>
              {isVol ? (
                <div className="pair">
                  <div className="field">
                    <select aria-label={`Pool of ${n}`} disabled={dis} value={d.pool} onChange={(e) => edit((x) => ((x[n].pool = e.target.value), (x[n].source = "")))}>
                      {[...new Set([...pools, d.pool])].map((p) => (
                        <option key={p}>{p}</option>
                      ))}
                    </select>
                  </div>
                  <div className={"field" + (errors["dev." + n] ? " bad" : "")}>
                    <select aria-label={`Volume of ${n}`} disabled={dis} value={d.source || ""} onChange={(e) => edit((x) => void (x[n].source = e.target.value))}>
                      <option value="">{custom.some((v) => v.pool === d.pool) ? "Choose a volume" : "No volumes in this pool"}</option>
                      {custom
                        .filter((v) => v.pool === d.pool)
                        .map((v) => (
                          <option key={v.name}>{v.name}</option>
                        ))}
                      {d.source && !custom.some((v) => v.pool === d.pool && v.name === d.source) && <option>{d.source}</option>}
                    </select>
                  </div>
                </div>
              ) : (
                <div className={"field mono-in" + (errors["dev." + n] ? " bad" : "")}>
                  <input aria-label={`Host path of ${n}`} disabled={dis} value={d.source || ""} onChange={(e) => edit((x) => void (x[n].source = e.target.value))} placeholder="/srv/data" />
                </div>
              )}
              <div className="field mono-in">
                <input aria-label={`Path inside for ${n}`} disabled={dis} value={d.path || ""} onChange={(e) => edit((x) => void (x[n].path = e.target.value))} placeholder="/mnt/data" />
              </div>
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
            {dis && <span className="note">From profile {from}</span>}
            {errors["dev." + n] && <span className="note bad">{errors["dev." + n]}</span>}
          </div>
        );
      })}
      <div>
        <button className="btn btn-s btn-sm press" onClick={() => edit((x) => void (x[nextName(x, "disk", inherited.map((i) => i[0]))] = { type: "disk", source: "", path: "" }))}>
          {ic.plus}Add disk
        </button>
      </div>
    </div>
  );
}

// ---------- port forwarding ----------

type Fwd = { proto: "tcp" | "udp"; laddr: string; lport: string; caddr: string; cport: string };
function parseEnd(s: string | undefined) {
  const m = /^(tcp|udp):(.*):([\d,-]*)$/.exec(s || "");
  return m ? { proto: m[1] as "tcp" | "udp", addr: m[2], port: m[3] } : null;
}
function parseFwd(d: Dev): Fwd | null {
  const l = parseEnd(d.listen),
    c = parseEnd(d.connect);
  if (!l || !c || l.proto !== c.proto) return null;
  return { proto: l.proto, laddr: l.addr, lport: l.port, caddr: c.addr, cport: c.port };
}
const scopeOf = (a: string) => (a === "0.0.0.0" || a === "[::]" || a === "::" ? "any" : a === "127.0.0.1" || a === "[::1]" ? "host" : "lan");
const scopeNote = {
  any: "Open to anyone who can reach this host, including the internet if the host is public.",
  lan: "Only reachable on the network of that host address.",
  host: "Only programs on the host itself can connect.",
};

// VmProxy is set for a virtual machine. Incus forwards ports to a VM only
// in NAT mode: it listens on one host address (not every address) and
// forwards to the fixed IPv4 address of the VM's network card. block says
// why a forward can't be added yet.
export type VmProxy = { block?: string };

export function ProxyEditor({ devices, inherited = [], edit, server, errors = {}, vm }: { devices: Devs; inherited?: Inherited; edit: Edit; server: string; errors?: Record<string, string>; vm?: VmProxy }) {
  const info = useServerInfo(server);
  const lanAddr = ((info.data?.environment?.addresses as string[]) || []).map((a) => a.replace(/:\d+$/, "")).find((a) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a)) || "";
  const rows: [string, Dev, string | null][] = [
    ...inherited.filter(([n]) => !devices[n]).map(([n, d, p]) => [n, d, p] as [string, Dev, string | null]),
    ...Object.entries(devices).filter(([, d]) => d.type === "proxy").map(([n, d]) => [n, d, null] as [string, Dev, string | null]),
  ];
  const set = (n: string, f: Fwd) =>
    edit((x) => {
      x[n].listen = `${f.proto}:${f.laddr}:${f.lport}`;
      // A VM can't be reached on 127.0.0.1; 0.0.0.0 means its fixed IPv4 address.
      x[n].connect = `${f.proto}:${vm && scopeOf(f.caddr) === "host" ? "0.0.0.0" : f.caddr}:${f.cport}`;
      if (vm) x[n].nat = "true";
    });
  return (
    <div className="hc devl">
      {rows.length > 0 && (
        <div className="dev px">
          <span className="hdr">Name</span>
          <span className="hdr">Protocol</span>
          <span className="hdr">Reachable from</span>
          <span className="hdr">Host port</span>
          <span className="hdr">Instance port</span>
          <span />
        </div>
      )}
      {rows.map(([n, d, from]) => {
        const f = parseFwd(d);
        const dis = from != null;
        if (!f)
          return (
            <div key={n} className="dev px">
              <div className="field mono-in">
                <input value={n} readOnly aria-label="Device name" />
              </div>
              <span className="note" style={{ gridColumn: "2 / 6" }}>
                <span className="mono">
                  {d.listen} → {d.connect}
                </span>{" "}
                Edit this in the YAML view.
              </span>
              <button className="btn btn-q ib btn-sm" aria-label={"Remove " + n} disabled={dis} onClick={() => edit((x) => void delete x[n])}>
                {ic.x}
              </button>
            </div>
          );
        const sc = scopeOf(f.laddr);
        return (
          <div key={n} data-f={"dev." + n}>
            <div className="dev px">
              <div className="field mono-in">
                <input value={n} readOnly aria-label="Device name" />
              </div>
              <div className="field">
                <select aria-label={`Protocol of ${n}`} disabled={dis} value={f.proto} onChange={(e) => set(n, { ...f, proto: e.target.value as "tcp" | "udp" })}>
                  <option>tcp</option>
                  <option>udp</option>
                </select>
              </div>
              <div className="pair one">
                {vm ? (
                  <div className="field mono-in">
                    <input aria-label={`Host address of ${n}`} disabled={dis} value={sc === "any" ? "" : f.laddr} placeholder={lanAddr || "Host address"} onChange={(e) => set(n, { ...f, laddr: e.target.value })} />
                  </div>
                ) : (
                <div className="field">
                  <select
                    aria-label={`Reachable from, ${n}`}
                    disabled={dis}
                    value={sc}
                    onChange={(e) => set(n, { ...f, laddr: e.target.value === "any" ? "0.0.0.0" : e.target.value === "host" ? "127.0.0.1" : lanAddr || "192.168.0.1" })}
                  >
                    <option value="any">Anywhere, including the internet</option>
                    <option value="lan">Local network only</option>
                    <option value="host">This host only</option>
                  </select>
                </div>
                )}
                {!vm && sc === "lan" && (
                  <div className="field mono-in">
                    <input aria-label={`Host address of ${n}`} disabled={dis} value={f.laddr} placeholder="Host address" onChange={(e) => set(n, { ...f, laddr: e.target.value })} />
                  </div>
                )}
              </div>
              <div className="field mono-in">
                <input aria-label={`Host port of ${n}`} inputMode="numeric" disabled={dis} value={f.lport} placeholder="8080" onChange={(e) => set(n, { ...f, lport: e.target.value.replace(/[^\d,-]/g, "") })} />
              </div>
              <div className="field mono-in">
                <input aria-label={`Instance port of ${n}`} inputMode="numeric" disabled={dis} value={f.cport} placeholder="80" onChange={(e) => set(n, { ...f, cport: e.target.value.replace(/[^\d,-]/g, "") })} />
              </div>
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
            <span className="note">
              {vm ? "Reachable on this host address. Incus sends the traffic to the VM's fixed IPv4 address." : scopeNote[sc]}
              {dis ? ` From profile ${from}.` : ""}
            </span>
            {errors["dev." + n] && (
              <>
                {" "}
                <span className="note bad">{errors["dev." + n]}</span>
              </>
            )}
          </div>
        );
      })}
      <div>
        <button
          className="btn btn-s btn-sm press"
          disabled={!!vm?.block}
          onClick={() =>
            edit(
              (x) =>
                void (x[nextName(x, "proxy", inherited.map((i) => i[0]))] = vm
                  ? // As the connect address, 0.0.0.0 means the NIC's fixed IPv4 address.
                    { type: "proxy", nat: "true", listen: `tcp:${lanAddr}:`, connect: "tcp:0.0.0.0:" }
                  : { type: "proxy", listen: "tcp:0.0.0.0:", connect: "tcp:127.0.0.1:" }),
            )
          }
        >
          {ic.plus}Add port forward
        </button>
      </div>
      {vm?.block && <span className="note">{vm.block}</span>}
    </div>
  );
}

// Returns a message per bad device, keyed "dev.<name>".
export function checkDevices(devices: Devs, vm = false): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [n, d] of Object.entries(devices)) {
    if (d.type === "disk" && n !== "root") {
      const vol = !!d.pool && !d.source?.startsWith("/");
      if (vol && !d.source) out["dev." + n] = "Choose a volume.";
      else if (!vol && !d.source) out["dev." + n] = "Enter the host path, or switch to a storage volume.";
      else if (!vol && !d.source.startsWith("/")) out["dev." + n] = "The host path must be absolute, like /srv/data. To use a storage volume, switch the source.";
      else if (!d.path) out["dev." + n] = "Enter the path inside the instance, like /mnt/data.";
      else if (!d.path.startsWith("/")) out["dev." + n] = "The path inside must start with /.";
    } else if (d.type === "proxy") {
      const f = parseFwd(d);
      if (!f) continue;
      const ports = (v: string) => v !== "" && v.split(",").every(portsOK);
      if (!ports(f.lport)) out["dev." + n] = "Enter the host port, from 1 to 65535.";
      else if (!ports(f.cport)) out["dev." + n] = "Enter the instance port, from 1 to 65535.";
      else if (vm && d.nat !== "true") out["dev." + n] = "A VM needs NAT mode for port forwarding. Enter the host address again to switch this forward to it.";
      else if (vm && scopeOf(f.laddr) !== "lan") out["dev." + n] = "A VM can only forward from one host address. Enter it, like 192.168.1.10.";
      else if (scopeOf(f.laddr) === "lan" && !/^(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])$/i.test(f.laddr)) out["dev." + n] = "Enter the host address to listen on, like 192.168.1.10.";
    }
  }
  return out;
}
