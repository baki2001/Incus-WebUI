import { useEffect, useState } from "react";
import { ApiError, incus, incusOp } from "../api";
import { ic } from "../icons";
import { useCrumbs } from "../Shell";
import { invalidate, useApp, useData, useScopedServers } from "../state";
import { useCollection, useCurrentProject, useServerInfo } from "../data";
import { confirmDialog, Dialog, Field, Input, KVEditor, Seg, Select, SheetSec, Table, TglRow, type Col } from "../ui";
import { EditSheet, matches, PageHead, Search, UsedBy } from "./Resource";
import { UsedBySec, usedByBody, useOpenParam } from "./usedby";

type Net = { name: string; type: string; description: string; managed: boolean; status: string; config: Record<string, string>; used_by: string[]; server: string };
type NetPut = { name?: string; type?: string; description: string; config: Record<string, string> };

// A bridge coming up can drop the browser's connection for a moment (the UI
// may run on the Incus host itself). When a request fails without an answer,
// look at the network instead of guessing: it has either finished or it hasn't.
const dropped = (e: unknown) => !(e instanceof ApiError) || e.status >= 502;

const netState = (s: string) => (s === "Created" ? "Created" : s === "Pending" ? "Setting up" : s === "Errored" ? "Failed" : s || "Unknown");

async function recheck(server: string, name: string, project: string, done: (n: Net | null) => boolean, what: string, progress: (d: string) => void) {
  progress("Reconnecting");
  let last = "";
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, i ? 2000 : 1000));
    try {
      const n = await incus<Net>(server, `/1.0/networks/${encodeURIComponent(name)}`, { project }).catch((e) => {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      });
      if (n?.status === "Errored") throw new ApiError(500, `Network ${name} failed to start${n.config?.["volatile.last_state.error"] ? ": " + n.config["volatile.last_state.error"] : ""}. Delete it and check the settings.`);
      if (done(n)) return;
      last = n ? netState(n.status) : "gone";
      progress(last === "Setting up" ? "Setting up the network" : "Waiting for Incus");
    } catch (e) {
      if (!dropped(e)) throw e;
    }
  }
  throw new Error(`Lost the connection while ${what}, and ${name} is ${last ? last.toLowerCase() : "not reachable"} now. Check the Networks list; it updates by itself.`);
}

// Runs a network change; if the connection drops half way, finish by checking the result.
async function netChange(server: string, name: string, project: string, act: () => Promise<unknown>, done: (n: Net | null) => boolean, what: string, progress: (d: string) => void) {
  try {
    await act();
    return true;
  } catch (e) {
    if (!dropped(e)) throw e;
  }
  await recheck(server, name, project, done, what, progress);
  return true;
}

const created = (n: Net | null) => n?.status === "Created";
const applied = (want: Record<string, string>) => (n: Net | null) => !!n && n.status === "Created" && Object.entries(want).every(([k, v]) => n.config[k] === v);

const netKeys = [
  "ipv4.address", "ipv4.nat", "ipv4.dhcp", "ipv4.dhcp.ranges", "ipv4.firewall", "ipv4.routing", "ipv6.address", "ipv6.nat", "ipv6.dhcp", "ipv6.dhcp.stateful",
  "dns.domain", "dns.mode", "dns.nameservers", "bridge.mtu", "bridge.driver", "bridge.external_interfaces", "security.acls", "security.acls.default.ingress.action",
  "security.acls.default.egress.action", "raw.dnsmasq", "parent", "mtu", "vlan",
];

function ServerCol<T extends { server: string }>(multi: boolean): Col<T> {
  return { k: "server", label: "Server", cell: (r) => r.server, sort: (r) => r.server, hide: !multi, cls: "hide-m" };
}

export function Networks() {
  useCrumbs([{ label: "Networking" }, { label: "Networks" }]);
  const app = useApp();
  const project = useCurrentProject();
  const servers = useScopedServers();
  const multi = app.servers.length > 1;
  const [poll, setPoll] = useState(0);
  const q = useCollection<Net>("networks", "/1.0/networks?recursion=1", poll);
  const [search, setSearch] = useState("");
  const [edit, setEdit] = useState<Net | null>(null);
  const [create, setCreate] = useState(false);
  const settling = !!q.data?.some((n) => n.managed && n.status === "Pending");
  useEffect(() => setPoll(settling ? 3000 : 0), [settling]);
  useOpenParam(q.data, setEdit);
  const rows = q.data?.filter((n) => n.managed && matches(search, n.name, n.description, n.config["ipv4.address"], n.type));

  const del = async (n: Net) => {
    if (!(await confirmDialog({ title: `Delete network ${n.name}?`, body: usedByBody("These still use it; Incus refuses to delete it until they don't.", n.used_by, n.server), confirm: "Delete", danger: true }))) return;
    const ok = await app.run(`Deleting ${n.name}`, (progress) => netChange(n.server, n.name, project, () => incusOp(n.server, `/1.0/networks/${encodeURIComponent(n.name)}`, { method: "DELETE", project }), (x) => !x, "deleting it", progress), `Network ${n.name} deleted`);
    if (ok) {
      setEdit(null);
      invalidate("networks:");
    }
  };

  return (
    <>
      <PageHead title="Networks">
        <button className="btn btn-p press" onClick={() => setCreate(true)}>
          {ic.plus}Create network
        </button>
      </PageHead>
      <div className="fbar">
        <Search value={search} onChange={setSearch} placeholder="Filter by name, type, address" />
      </div>
      <Table<Net>
        rows={rows}
        loading={q.loading}
        rowKey={(n) => n.server + n.name}
        onRow={setEdit}
        empty={q.error || (search ? "No networks match." : "No managed networks yet.")}
        cols={[
          { k: "name", label: "Name", sort: (n) => n.name, cell: (n) => <NameCell name={n.name} sub={n.description} /> },
          { k: "type", label: "Type", sort: (n) => n.type, cell: (n) => n.type },
          ServerCol<Net>(multi),
          { k: "v4", label: "IPv4", sort: (n) => n.config["ipv4.address"], cell: (n) => <span className="mono">{!n.config["ipv4.address"] || n.config["ipv4.address"] === "none" ? "–" : n.config["ipv4.address"]}</span>, cls: "hide-s" },
          { k: "v6", label: "IPv6", sort: (n) => n.config["ipv6.address"], cell: (n) => <span className="mono dim">{!n.config["ipv6.address"] || n.config["ipv6.address"] === "none" ? "–" : n.config["ipv6.address"]}</span>, cls: "hide-m" },
          { k: "status", label: "State", sort: (n) => n.status, cell: (n) => <span className={"st " + (n.status === "Created" ? "running" : n.status === "Pending" ? "busy" : "error")}>{netState(n.status)}</span> },
          { k: "used", label: "Used by", sort: (n) => n.used_by?.length || 0, cell: (n) => <UsedBy list={n.used_by} />, cls: "right" },
        ]}
      />
      <NetworkSheet
        open={create}
        onClose={() => setCreate(false)}
        servers={servers.map((s) => s.name)}
        project={project}
        onSaved={() => invalidate("networks:")}
      />
      <NetworkSheet open={!!edit} net={edit} onClose={() => setEdit(null)} servers={[]} project={project} onSaved={() => invalidate("networks:")} onDelete={edit ? () => del(edit) : undefined} />
    </>
  );
}

export function NameCell({ name, sub }: { name: string; sub?: string }) {
  return (
    <span className="nm">
      <span className="nm2">{name}</span>
      {sub && <small className="dim">{sub}</small>}
    </span>
  );
}

function NetworkSheet({ open, net, onClose, servers, project, onSaved, onDelete }: { open: boolean; net?: Net | null; onClose: () => void; servers: string[]; project: string; onSaved: () => void; onDelete?: () => void }) {
  const app = useApp();
  const [server, setServer] = useState("");
  const srv = net?.server || server || servers[0] || "";
  const parents = useData<string[]>(open && srv ? `phys:${srv}` : null, async () => ((await incus<any[]>(srv, "/1.0/networks?recursion=1")) || []).filter((n) => !n.managed && n.type !== "loopback").map((n) => n.name));
  const acls = useData<string[]>(open && srv ? `acl-names:${srv}:${project}` : null, async () => ((await incus<string[]>(srv, "/1.0/network-acls", { project })) || []).map((u) => decodeURIComponent(u.split("/").pop()!)));
  const leases = useData<any[]>(open && net && net.type === "bridge" ? `leases:${net.server}:${net.name}` : null, () => incus(net!.server, `/1.0/networks/${encodeURIComponent(net!.name)}/leases`, { project }));
  const value: NetPut | null = net ? { description: net.description, config: net.config } : open ? { name: "", type: "bridge", description: "", config: { "ipv4.address": "auto", "ipv4.nat": "true", "ipv6.address": "none" } } : null;

  const save = async (d: NetPut) => {
    if (!net) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,14}$/.test(d.name || "")) {
        app.toast("Network names are up to 15 letters, numbers and dashes.");
        return false;
      }
      const ok = await app.run(`Creating ${d.name}`, (progress) => netChange(srv, d.name!, project, () => incusOp(srv, "/1.0/networks", { method: "POST", project, body: { ...d, config: clean(d.config) } }), created, "creating it", progress), `Network ${d.name} created`);
      if (ok) onSaved();
      return ok;
    }
    const ok = await app.run(`Saving ${net.name}`, (progress) => netChange(net.server, net.name, project, () => incusOp(net.server, `/1.0/networks/${encodeURIComponent(net.name)}`, { method: "PUT", project, body: { description: d.description, config: clean(d.config) } }), applied(clean(d.config)), "saving it", progress), `Network ${net.name} saved`);
    if (ok) onSaved();
    return ok;
  };

  return (
    <EditSheet<NetPut>
      open={open}
      onClose={onClose}
      title={net ? `Network ${net.name}` : "Create network"}
      value={value}
      create={!net}
      onSave={save}
      onDelete={onDelete}
      info={
        net && (
          <>
            {net.status !== "Created" && (
              <div className="notice sm">
                {net.status === "Pending" ? "This network is still being set up. If it stays like this, delete it and create it again." : `This network is ${netState(net.status).toLowerCase()}. Delete it and create it again, or check the settings below.`}
              </div>
            )}
            <UsedBySec list={net.used_by} server={net.server} />
            {net.status === "Created" && (net.type === "bridge" || net.type === "ovn") && <Forwards net={net} project={project} />}
            {leases.data && leases.data.length > 0 && (
              <SheetSec title={`DHCP leases (${leases.data.length})`}>
                <div className="dl">
                  {leases.data.map((l) => (
                    <div className="drow d3" key={l.address + l.hwaddr}>
                      <span>{l.hostname || "–"}</span>
                      <span className="mono">{l.address}</span>
                      <span className="dim">{l.type}</span>
                    </div>
                  ))}
                </div>
              </SheetSec>
            )}
          </>
        )
      }
      form={(d, set) => {
        const type = net?.type || d.type || "bridge";
        const v4 = d.config["ipv4.address"] ?? "";
        const v6 = d.config["ipv6.address"] ?? "";
        const mode = (v: string) => (v === "auto" ? "auto" : v === "none" || v === "" ? "none" : "custom");
        const setCfg = (k: string, v: string | undefined) => set((x) => (v === undefined || v === "" ? delete x.config[k] : (x.config[k] = v)));
        const bridgeLike = type === "bridge" || type === "ovn";
        const aclList = (d.config["security.acls"] || "").split(",").filter(Boolean);
        return (
          <>
            {!net && (
              <div className="two">
                <Field label="Name" hint="Up to 15 characters.">
                  <Input autoFocus mono value={d.name || ""} onChange={(v) => set((x) => void (x.name = v))} placeholder="lan0" />
                </Field>
                {servers.length > 1 ? (
                  <Field label="Server">
                    <Select value={srv} onChange={setServer} options={servers} />
                  </Field>
                ) : (
                  <span />
                )}
              </div>
            )}
            {!net && (
              <Field label="Type">
                <Seg
                  value={type}
                  onChange={(t) => set((x) => void ((x.type = t), (x.config = t === "bridge" ? { "ipv4.address": "auto", "ipv4.nat": "true", "ipv6.address": "none" } : {})))}
                  options={[
                    { v: "bridge", l: "Bridge" },
                    { v: "macvlan", l: "Macvlan" },
                    { v: "physical", l: "Physical" },
                    { v: "ovn", l: "OVN" },
                  ]}
                />
              </Field>
            )}
            <Field label="Description">
              <Input value={d.description} onChange={(v) => set((x) => void (x.description = v))} />
            </Field>
            {bridgeLike && (
              <>
                <SheetSec title="IPv4">
                  <Seg value={mode(v4)} onChange={(m) => setCfg("ipv4.address", m === "custom" ? "10.10.10.1/24" : m)} options={[{ v: "auto", l: "Automatic" }, { v: "custom", l: "Fixed" }, { v: "none", l: "Off" }]} />
                  {mode(v4) === "custom" && <Input mono value={v4} onChange={(v) => setCfg("ipv4.address", v)} placeholder="10.10.10.1/24" />}
                  {mode(v4) !== "none" && (
                    <div className="tglgrid">
                      <TglRow title="NAT" note="Instances reach outside through the host." on={d.config["ipv4.nat"] === "true"} onChange={(o) => setCfg("ipv4.nat", String(o))} />
                      <TglRow title="DHCP" note="Hand out addresses." on={d.config["ipv4.dhcp"] !== "false"} onChange={(o) => setCfg("ipv4.dhcp", o ? undefined : "false")} />
                    </div>
                  )}
                  {mode(v4) !== "none" && d.config["ipv4.dhcp"] !== "false" && (
                    <Field label="DHCP range" hint="Optional, like 10.10.10.100-10.10.10.200.">
                      <Input mono value={d.config["ipv4.dhcp.ranges"] || ""} onChange={(v) => setCfg("ipv4.dhcp.ranges", v)} />
                    </Field>
                  )}
                </SheetSec>
                <SheetSec title="IPv6">
                  <Seg value={mode(v6)} onChange={(m) => setCfg("ipv6.address", m === "custom" ? "fd42::1/64" : m)} options={[{ v: "auto", l: "Automatic" }, { v: "custom", l: "Fixed" }, { v: "none", l: "Off" }]} />
                  {mode(v6) === "custom" && <Input mono value={v6} onChange={(v) => setCfg("ipv6.address", v)} />}
                  {mode(v6) !== "none" && <TglRow title="NAT" on={d.config["ipv6.nat"] === "true"} onChange={(o) => setCfg("ipv6.nat", String(o))} />}
                </SheetSec>
                <div className="two">
                  <Field label="DNS domain" hint="Instances resolve as name.domain.">
                    <Input mono value={d.config["dns.domain"] || ""} onChange={(v) => setCfg("dns.domain", v)} placeholder="incus" />
                  </Field>
                  <Field label="MTU">
                    <Input mono value={d.config["bridge.mtu"] || ""} onChange={(v) => setCfg("bridge.mtu", v.replace(/\D/g, ""))} placeholder="1500" />
                  </Field>
                </div>
                <SheetSec title="ACLs">
                  {(acls.data?.length || 0) + aclList.length === 0 ? (
                    <span className="dim" style={{ fontSize: 12.5 }}>
                      No ACLs yet. Create one under Networking, ACLs, then pick it here.
                    </span>
                  ) : (
                    <>
                      <div className="pt">
                        {[...new Set([...(acls.data || []), ...aclList])].map((a) => (
                          <label key={a}>
                            <input type="checkbox" checked={aclList.includes(a)} onChange={(e) => setCfg("security.acls", (e.target.checked ? [...aclList, a] : aclList.filter((x) => x !== a)).join(","))} />
                            {a}
                            {!acls.data?.includes(a) && <small>missing</small>}
                          </label>
                        ))}
                      </div>
                      {aclList.length > 0 && (
                        <div className="two">
                          <Field label="Inbound with no matching rule">
                            <Select value={d.config["security.acls.default.ingress.action"] || "reject"} onChange={(v) => setCfg("security.acls.default.ingress.action", v)} options={["reject", "allow", "drop"]} />
                          </Field>
                          <Field label="Outbound with no matching rule">
                            <Select value={d.config["security.acls.default.egress.action"] || "reject"} onChange={(v) => setCfg("security.acls.default.egress.action", v)} options={["reject", "allow", "drop"]} />
                          </Field>
                        </div>
                      )}
                    </>
                  )}
                </SheetSec>
              </>
            )}
            {(type === "macvlan" || type === "physical" || type === "sriov") && (
              <Field label="Parent interface" hint="The host network card this network sits on.">
                <Select value={d.config.parent || ""} onChange={(v) => setCfg("parent", v)} options={[{ v: "", l: "Choose an interface" }, ...(parents.data || []).map((p) => ({ v: p, l: p }))]} />
              </Field>
            )}
            {type === "ovn" && (
              <Field label="Uplink network" hint="A physical or bridge network with an uplink range.">
                <Input mono value={d.config.network || ""} onChange={(v) => setCfg("network", v)} placeholder="UPLINK" />
              </Field>
            )}
            <SheetSec title="All settings">
              <KVEditor value={d.config} onChange={(c) => set((x) => void (x.config = c))} keys={netKeys} hide={(k) => k.startsWith("volatile.")} />
            </SheetSec>
          </>
        );
      }}
    />
  );
}

// ---------- Port forwards ----------

type FPort = { description?: string; protocol: string; listen_port: string; target_port?: string; target_address?: string };
type Fwd = { listen_address: string; description: string; config: Record<string, string>; ports: FPort[] };

const fwdPath = (net: Net, addr?: string) => `/1.0/networks/${encodeURIComponent(net.name)}/forwards` + (addr ? "/" + encodeURIComponent(addr) : "");

function Forwards({ net, project }: { net: Net; project: string }) {
  const app = useApp();
  const key = `forwards:${net.server}:${project}:${net.name}`;
  const q = useData<Fwd[]>(key, async () => (await incus<Fwd[]>(net.server, fwdPath(net) + "?recursion=1", { project })) || []);
  const [edit, setEdit] = useState<Fwd | null>(null);
  const [isNew, setIsNew] = useState(false);
  const blank = (): Fwd => ({ listen_address: "", description: "", config: { target_address: "" }, ports: [{ protocol: "tcp", listen_port: "", target_port: "", target_address: "" }] });
  const close = () => setEdit(null);

  const save = async (f: Fwd) => {
    if (!f.listen_address.trim()) return void app.toast("Enter the listen address, an address on this server like 192.168.1.20.");
    const dflt = f.config.target_address?.trim() || "";
    // Incus wants a target on every port and refuses one that equals the default
    // target, so a port without its own target gets the default, and then the
    // default itself (the catch-all for other traffic) is left out.
    const ports = f.ports
      .filter((p) => p.listen_port.trim())
      .map((p) => Object.fromEntries(Object.entries({ ...p, target_address: p.target_address?.trim() || dflt }).filter(([, v]) => v !== "" && v !== undefined)));
    if (!ports.length && !dflt) return void app.toast("Add a port, or a target address that gets all traffic.");
    const config = dflt && !ports.some((p) => p.target_address === dflt) ? { target_address: dflt } : {};
    const body = { listen_address: f.listen_address.trim(), description: f.description, config, ports };
    const ok = await app.run(
      isNew ? "Adding port forward" : "Saving port forward",
      () => (isNew ? incusOp(net.server, fwdPath(net), { method: "POST", project, body }) : incusOp(net.server, fwdPath(net, f.listen_address), { method: "PUT", project, body: { description: body.description, config, ports } })).then(() => true),
      "Port forward saved",
    );
    if (ok) {
      close();
      invalidate("forwards:");
    }
  };
  const del = async (f: Fwd) => {
    if (!(await confirmDialog({ title: `Delete the forward on ${f.listen_address}?`, body: "Traffic to that address will stop reaching the instances.", confirm: "Delete", danger: true }))) return;
    const ok = await app.run("Deleting port forward", () => incusOp(net.server, fwdPath(net, f.listen_address), { method: "DELETE", project }).then(() => true), "Port forward deleted");
    if (ok) {
      close();
      invalidate("forwards:");
    }
  };
  const summary = (f: Fwd) =>
    (f.ports || []).map((p) => `${p.protocol} ${p.listen_port} to ${p.target_address || f.config?.target_address || "?"}:${p.target_port || p.listen_port}`).join(", ") || (f.config?.target_address ? `everything to ${f.config.target_address}` : "–");

  return (
    <>
      <SheetSec
        title={`Port forwards${q.data?.length ? ` (${q.data.length})` : ""}`}
        action={
          <button
            className="btn btn-s btn-sm press"
            onClick={() => {
              setIsNew(true);
              setEdit(blank());
            }}
          >
            {ic.plus}Add
          </button>
        }
      >
        {q.data && q.data.length > 0 ? (
          <div className="dl">
            {q.data.map((f) => (
              <div
                className="drow fwd"
                key={f.listen_address}
                role="button"
                tabIndex={0}
                onClick={() => {
                  setIsNew(false);
                  setEdit(JSON.parse(JSON.stringify({ ...f, config: { target_address: f.config?.target_address || "" }, ports: f.ports || [] })));
                }}
                onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLElement).click()}
              >
                <span className="mono">{f.listen_address}</span>
                <span className="dim">{summary(f)}</span>
              </div>
            ))}
          </div>
        ) : (
          <span className="dim" style={{ fontSize: 12.5 }}>
            {q.error || "No forwards. A forward sends traffic that arrives on a server address to an instance on this network."}
          </span>
        )}
      </SheetSec>
      <Dialog open={!!edit} onClose={close} size="md">
        {edit && <FwdForm key={isNew ? "new" : edit.listen_address} net={net} project={project} init={edit} isNew={isNew} onSave={save} onDelete={() => del(edit)} onClose={close} />}
      </Dialog>
    </>
  );
}

// "10.115.217.1/24" -> "10.115.217.10", an example inside the subnet.
function subnetExample(cidr?: string) {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/.exec(cidr || "");
  if (!m) return "10.0.0.10";
  const ip = ((+m[1] << 24) | (+m[2] << 16) | (+m[3] << 8) | +m[4]) >>> 0;
  const bits = +m[5];
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  const net = (ip & mask) >>> 0;
  const host = bits >= 30 ? ip + 1 : net + 10;
  return [host >>> 24, (host >>> 16) & 255, (host >>> 8) & 255, host & 255].join(".");
}

type Addr = { v: string; l: string };

// Addresses on this server a forward can listen on: its API addresses and global addresses of its physical networks.
function useHostAddrs(server: string, project: string) {
  const info = useServerInfo(server);
  const q = useData<string[]>(`hostaddrs:${server}:${project}`, async () => {
    const nets = (await incus<{ name: string; managed: boolean; type: string }[]>(server, "/1.0/networks?recursion=1", { project })) || [];
    const out: string[] = [];
    for (const n of nets.filter((x) => !x.managed && x.type !== "loopback")) {
      const st = await incus<{ addresses?: { address: string; family: string; scope: string }[] }>(server, `/1.0/networks/${encodeURIComponent(n.name)}/state`, { project }).catch(() => null);
      for (const a of st?.addresses || []) if (a.scope === "global") out.push(a.address);
    }
    return out;
  });
  const api = ((info.data?.environment?.addresses as string[]) || []).map((a) => a.replace(/^\[(.*)\]:\d+$/, "$1").replace(/:\d+$/, "")).filter((a) => a && a !== "::" && a !== "0.0.0.0" && !a.startsWith("127.") && a !== "::1");
  return [...new Set([...(q.data || []), ...api])];
}

type Inst = { name: string; expanded_devices?: Record<string, Record<string, string>>; state?: { network?: Record<string, { addresses: { address: string; family: string; scope: string }[] }> } };

// Instances attached to this network, with their IPv4 address.
function useNetInstances(net: Net, project: string) {
  const q = useData<Addr[]>(`netinst:${net.server}:${project}:${net.name}`, async () => {
    const list = (await incus<Inst[]>(net.server, "/1.0/instances?recursion=2", { project })) || [];
    const out: Addr[] = [];
    for (const i of list)
      for (const [dev, d] of Object.entries(i.expanded_devices || {})) {
        if (d.type !== "nic" || (d.network !== net.name && d.parent !== net.name)) continue;
        const ip = i.state?.network?.[dev]?.addresses.find((a) => a.family === "inet" && a.scope === "global")?.address;
        if (ip) out.push({ v: ip, l: `${i.name} (${ip})` });
      }
    return out;
  });
  return q.data || [];
}

// A select of suggestions with an "Other" entry that turns into a text box.
function AddrPick({ value, onChange, options, placeholder, label, readOnly, autoFocus }: { value: string; onChange: (v: string) => void; options: Addr[]; placeholder: string; label: string; readOnly?: boolean; autoFocus?: boolean }) {
  const known = options.some((o) => o.v === value);
  const [other, setOther] = useState(!!value && !known);
  if (!options.length || readOnly || other)
    return (
      <div style={{ display: "flex", gap: 6 }}>
        <div style={{ flex: 1 }}>
          <Input mono value={value} readOnly={readOnly} autoFocus={autoFocus} onChange={onChange} placeholder={placeholder} aria-label={label} />
        </div>
        {other && !readOnly && options.length > 0 && (
          <button type="button" className="btn btn-s btn-sm press" onClick={() => (setOther(false), onChange(""))}>
            List
          </button>
        )}
      </div>
    );
  return (
    <Select
      value={known ? value : ""}
      onChange={(v) => (v === "__other" ? (setOther(true), onChange("")) : onChange(v))}
      options={[{ v: "", l: "Choose…" }, ...options, { v: "__other", l: "Other…" }]}
      aria-label={label}
    />
  );
}

function FwdForm({ net, project, init, isNew, onSave, onDelete, onClose }: { net: Net; project: string; init: Fwd; isNew: boolean; onSave: (f: Fwd) => void; onDelete: () => void; onClose: () => void }) {
  const [f, setF] = useState(init);
  const [tried, setTried] = useState(false);
  const hostAddrs = useHostAddrs(net.server, project);
  const insts = useNetInstances(net, project);
  const eg = subnetExample(net.config["ipv4.address"]);
  const dflt = f.config.target_address?.trim() || "";
  const listenErr = tried && !f.listen_address.trim() ? "Choose or enter an address on this server." : "";
  const noTarget = (p: FPort) => !!p.listen_port.trim() && !dflt && !p.target_address?.trim();
  const defErr = tried && !f.ports.some((p) => p.listen_port.trim()) && !dflt ? "Enter a target address, or add a port." : "";
  const submit = () => {
    setTried(true);
    if (!f.listen_address.trim() || f.ports.some(noTarget) || (!f.ports.some((p) => p.listen_port.trim()) && !dflt)) return;
    onSave(f);
  };
  const setPort = (i: number, k: keyof FPort, v: string) => setF({ ...f, ports: f.ports.map((p, j) => (j === i ? { ...p, [k]: v } : p)) });
  return (
    <>
      <div className="dlg-b fdlg">
        <h2>{isNew ? "Add port forward" : "Port forward " + f.listen_address}</h2>
        <div className="two" style={{ marginTop: 12 }}>
          <Field label="Listen address" bad={!!listenErr} hint={listenErr || "An address on the server."}>
            <AddrPick label="Listen address" readOnly={!isNew} autoFocus={isNew} value={f.listen_address} onChange={(v) => setF({ ...f, listen_address: v })} options={hostAddrs.map((a) => ({ v: a, l: a }))} placeholder="192.168.1.20" />
          </Field>
          <Field label="Target address" bad={!!defErr} hint={defErr || "Gets the ports that have no target of their own, or all traffic if there are no ports."}>
            <AddrPick label="Target address" value={f.config.target_address || ""} onChange={(v) => setF({ ...f, config: { target_address: v } })} options={insts} placeholder={eg} />
          </Field>
        </div>
        <Field label="Description">
          <Input value={f.description} onChange={(v) => setF({ ...f, description: v })} />
        </Field>
        <SheetSec
          title="Ports"
          action={
            <button className="btn btn-s btn-sm press" onClick={() => setF({ ...f, ports: [...f.ports, { protocol: "tcp", listen_port: "", target_port: "", target_address: "" }] })}>
              {ic.plus}Add port
            </button>
          }
        >
          {f.ports.length > 0 && (
            <div className="rules">
              <div className="fports hdr">
                <span>Protocol</span>
                <span>Listen port</span>
                <span>Target port</span>
                <span>Target address</span>
                <span />
              </div>
              {f.ports.map((p, i) => (
                <div className="fports" key={i}>
                  <Select value={p.protocol} onChange={(v) => setPort(i, "protocol", v)} options={["tcp", "udp"]} aria-label="Protocol" />
                  <Input mono value={p.listen_port} onChange={(v) => setPort(i, "listen_port", v.replace(/[^\d,-]/g, ""))} placeholder="80 or 8000-8010" aria-label="Listen port" />
                  <Input mono value={p.target_port || ""} onChange={(v) => setPort(i, "target_port", v.replace(/[^\d,-]/g, ""))} placeholder="same" aria-label="Target port" />
                  <Input mono bad={tried && noTarget(p)} list={`fwd-t-${net.name}`} value={p.target_address || ""} onChange={(v) => setPort(i, "target_address", v)} placeholder={dflt || eg} aria-label="Target address" />
                  <button className="btn btn-q ib btn-sm" aria-label="Remove port" onClick={() => setF({ ...f, ports: f.ports.filter((_, j) => j !== i) })}>
                    {ic.x}
                  </button>
                </div>
              ))}
            </div>
          )}
          <datalist id={`fwd-t-${net.name}`}>
            {insts.map((o) => (
              <option key={o.v} value={o.v}>
                {o.l}
              </option>
            ))}
          </datalist>
          {tried && f.ports.some(noTarget) && <div className="hint bad">Each port needs a target address, or set one above for all ports.</div>}
        </SheetSec>
      </div>
      <div className="dlg-f">
        {!isNew && (
          <button className="btn btn-q press" style={{ color: "var(--err)", marginRight: "auto" }} onClick={onDelete}>
            {ic.trash}Delete
          </button>
        )}
        <button className="btn btn-s press" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-p press" onClick={submit}>
          {isNew ? "Add" : "Save"}
        </button>
      </div>
    </>
  );
}

function clean(c: Record<string, string>) {
  const o: Record<string, string> = {};
  for (const [k, v] of Object.entries(c)) if (k && !k.startsWith("volatile.")) o[k] = v;
  return o;
}

// ---------- ACLs ----------

type Rule = { action: string; state: string; description?: string; source?: string; destination?: string; protocol?: string; source_port?: string; destination_port?: string; icmp_type?: string; icmp_code?: string };
type Acl = { name: string; description: string; ingress: Rule[]; egress: Rule[]; config: Record<string, string>; used_by: string[]; server: string };
type AclPut = { name?: string; description: string; ingress: Rule[]; egress: Rule[]; config: Record<string, string>; networks?: string[] };

const aclsOf = (n: Net) => (n.config["security.acls"] || "").split(",").map((x) => x.trim()).filter(Boolean);

export function Acls() {
  useCrumbs([{ label: "Networking" }, { label: "ACLs" }]);
  const app = useApp();
  const project = useCurrentProject();
  const servers = useScopedServers();
  const multi = app.servers.length > 1;
  const q = useCollection<Acl>("acls", "/1.0/network-acls?recursion=1");
  const nets = useCollection<Net>("networks", "/1.0/networks?recursion=1");
  const [search, setSearch] = useState("");
  const [edit, setEdit] = useState<Acl | null>(null);
  useOpenParam(q.data, setEdit);
  const [create, setCreate] = useState(false);
  const [server, setServer] = useState("");
  const srv = edit?.server || server || servers[0]?.name || "";
  // Only bridge and OVN networks take ACLs.
  const attachable = (nets.data || []).filter((n) => n.managed && (n.type === "bridge" || n.type === "ovn") && n.server === srv);
  const attached = (a: string) => attachable.filter((n) => aclsOf(n).includes(a)).map((n) => n.name);

  // Adds or removes this ACL on networks, keeping everything else on them.
  const attach = async (name: string, want: string[], was: string[], progress: (d: string) => void) => {
    for (const n of attachable.filter((x) => want.includes(x.name) !== was.includes(x.name))) {
      const cur = await incus<Net>(n.server, `/1.0/networks/${encodeURIComponent(n.name)}`, { project });
      const list = aclsOf(cur).filter((x) => x !== name);
      if (want.includes(n.name)) list.push(name);
      const config = clean({ ...cur.config, "security.acls": list.join(",") });
      if (!list.length) delete config["security.acls"];
      await netChange(n.server, n.name, project, () => incusOp(n.server, `/1.0/networks/${encodeURIComponent(n.name)}`, { method: "PUT", project, body: { description: cur.description, config } }), applied(config), "updating it", progress);
    }
    return true;
  };
  const save = async (d: AclPut) => {
    const { networks: want = [], ...rest } = d;
    const body = { ...rest, ingress: d.ingress.map(cleanRule), egress: d.egress.map(cleanRule) };
    if (!edit) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(d.name || "")) return void app.toast("Give the ACL a name.");
      const ok = await app.run(`Creating ${d.name}`, async (progress) => (await incusOp(srv, "/1.0/network-acls", { method: "POST", project, body }), want.length ? attach(d.name!, want, [], progress) : true), `ACL ${d.name} created`);
      if (ok) invalidate("acls:"), invalidate("acl-names:"), invalidate("networks:");
      return ok;
    }
    const ok = await app.run(`Saving ${edit.name}`, async (progress) => (await incusOp(edit.server, `/1.0/network-acls/${encodeURIComponent(edit.name)}`, { method: "PUT", project, body: { description: body.description, ingress: body.ingress, egress: body.egress, config: body.config } }), attach(edit.name, want, attached(edit.name), progress)), `ACL ${edit.name} saved`);
    if (ok) invalidate("acls:"), invalidate("networks:");
    return ok;
  };
  const del = async (a: Acl) => {
    if (!(await confirmDialog({ title: `Delete ACL ${a.name}?`, body: usedByBody("These still use it; remove it from them first.", a.used_by, a.server), confirm: "Delete", danger: true }))) return;
    const ok = await app.run(`Deleting ${a.name}`, () => incusOp(a.server, `/1.0/network-acls/${encodeURIComponent(a.name)}`, { method: "DELETE", project }).then(() => true), `ACL ${a.name} deleted`);
    if (ok) {
      setEdit(null);
      invalidate("acls:");
    }
  };

  return (
    <>
      <PageHead title="ACLs">
        <button className="btn btn-p press" onClick={() => setCreate(true)}>
          {ic.plus}Create ACL
        </button>
      </PageHead>
      <div className="fbar">
        <Search value={search} onChange={setSearch} placeholder="Filter by name" />
        <span className="dim fnote">Firewall rules you attach to networks or to single network cards.</span>
      </div>
      <Table<Acl>
        rows={q.data?.filter((a) => matches(search, a.name, a.description))}
        loading={q.loading}
        rowKey={(a) => a.server + a.name}
        onRow={setEdit}
        empty={q.error || (search ? "No ACLs match." : "No ACLs yet.")}
        cols={[
          { k: "name", label: "Name", sort: (a) => a.name, cell: (a) => <NameCell name={a.name} sub={a.description} /> },
          ServerCol<Acl>(multi),
          { k: "in", label: "Ingress rules", sort: (a) => a.ingress?.length || 0, cell: (a) => a.ingress?.length || 0, cls: "right" },
          { k: "out", label: "Egress rules", sort: (a) => a.egress?.length || 0, cell: (a) => a.egress?.length || 0, cls: "right" },
          { k: "used", label: "Used by", sort: (a) => a.used_by?.length || 0, cell: (a) => <UsedBy list={a.used_by} />, cls: "right" },
        ]}
      />
      <EditSheet<AclPut>
        open={create || !!edit}
        onClose={() => (setCreate(false), setEdit(null))}
        title={edit ? `ACL ${edit.name}` : "Create ACL"}
        create={!edit}
        value={edit ? { description: edit.description, ingress: edit.ingress || [], egress: edit.egress || [], config: edit.config || {}, networks: attached(edit.name) } : create ? { name: "", description: "", ingress: [], egress: [], config: {}, networks: [] } : null}
        info={edit && <UsedBySec list={edit.used_by} server={edit.server} />}
        onSave={save}
        validate={(d) => {
          for (const [dir, rules] of [["Ingress", d.ingress], ["Egress", d.egress]] as const)
            for (const [i, r] of (rules || []).entries()) {
              const bad = r.destination_port && badPorts(r.destination_port);
              if (bad) return `${dir} rule ${i + 1}: ${bad}`;
            }
          return "";
        }}
        onDelete={edit ? () => del(edit) : undefined}
        form={(d, set) => (
          <>
            {!edit && (
              <div className="two">
                <Field label="Name">
                  <Input autoFocus mono value={d.name || ""} onChange={(v) => set((x) => void (x.name = v))} placeholder="web" />
                </Field>
                {servers.length > 1 ? (
                  <Field label="Server">
                    <Select value={srv} onChange={setServer} options={servers.map((s) => s.name)} />
                  </Field>
                ) : (
                  <span />
                )}
              </div>
            )}
            <Field label="Description">
              <Input value={d.description} onChange={(v) => set((x) => void (x.description = v))} />
            </Field>
            <RuleList title="Ingress, traffic coming in" rules={d.ingress} onChange={(r) => set((x) => void (x.ingress = r))} />
            <RuleList title="Egress, traffic going out" rules={d.egress} onChange={(r) => set((x) => void (x.egress = r))} />
            <SheetSec title="Networks">
              {attachable.length ? (
                <div className="pt">
                  {attachable.map((n) => (
                    <label key={n.name}>
                      <input type="checkbox" checked={(d.networks || []).includes(n.name)} onChange={(e) => set((x) => void (x.networks = e.target.checked ? [...(x.networks || []), n.name] : (x.networks || []).filter((y) => y !== n.name)))} />
                      {n.name}
                      <small>{n.type}</small>
                    </label>
                  ))}
                </div>
              ) : (
                <span className="dim" style={{ fontSize: 12.5 }}>
                  No bridge or OVN networks to attach it to.
                </span>
              )}
              <span className="dim" style={{ fontSize: 12.5 }}>
                Ticked networks apply this ACL to everything connected to them.
              </span>
            </SheetSec>
            <span className="dim" style={{ fontSize: 12.5 }}>
              Source and destination take addresses, ranges or subnets (comma separated), or another ACL's name. Traffic no rule matches gets the network's default action.
            </span>
          </>
        )}
      />
    </>
  );
}

// Ports are numbers, ranges like 80-90, or comma lists of both. Returns a message when not.
export function badPorts(v: string) {
  for (const part of v.split(",").map((x) => x.trim())) {
    const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(part);
    const [a, b] = m ? [+m[1], m[2] ? +m[2] : +m[1]] : [0, 0];
    if (!m || a < 1 || b > 65535 || a > b) return `"${v}" is not a valid port. Use numbers like 22, ranges like 80-90, or a comma list like 80,443.`;
  }
  return "";
}

function cleanRule(r: Rule): Rule {
  const o: any = {};
  for (const [k, v] of Object.entries(r)) if (v !== "" && v !== undefined) o[k] = v;
  return o;
}

function RuleList({ title, rules, onChange }: { title: string; rules: Rule[]; onChange: (r: Rule[]) => void }) {
  const set = (i: number, k: keyof Rule, v: string) => onChange(rules.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return (
    <SheetSec
      title={title}
      action={
        <button className="btn btn-s btn-sm press" onClick={() => onChange([...rules, { action: "allow", state: "enabled", protocol: "tcp", destination_port: "" }])}>
          {ic.plus}Add rule
        </button>
      }
    >
      {rules.length > 0 && (
        <div className="rules">
          <div className="rule hdr">
            <span>Action</span>
            <span>Protocol</span>
            <span>Source</span>
            <span>Destination</span>
            <span>Port</span>
            <span>State</span>
            <span />
          </div>
          {rules.map((r, i) => (
            <div className="rule" key={i}>
              <Select value={r.action} onChange={(v) => set(i, "action", v)} options={["allow", "reject", "drop"]} />
              <Select value={r.protocol || ""} onChange={(v) => set(i, "protocol", v)} options={[{ v: "", l: "any" }, "tcp", "udp", "icmp4", "icmp6"]} />
              <Input mono value={r.source || ""} onChange={(v) => set(i, "source", v)} placeholder="any" />
              <Input mono value={r.destination || ""} onChange={(v) => set(i, "destination", v)} placeholder="any" />
              <Input mono value={r.destination_port || ""} onChange={(v) => set(i, "destination_port", v)} placeholder={r.protocol === "tcp" || r.protocol === "udp" ? "any" : "–"} disabled={r.protocol !== "tcp" && r.protocol !== "udp"} />
              <Select value={r.state} onChange={(v) => set(i, "state", v)} options={[{ v: "enabled", l: "on" }, { v: "disabled", l: "off" }, { v: "logged", l: "log" }]} />
              <button className="btn btn-q ib btn-sm" aria-label="Remove rule" onClick={() => onChange(rules.filter((_, j) => j !== i))}>
                {ic.x}
              </button>
            </div>
          ))}
        </div>
      )}
    </SheetSec>
  );
}

// ---------- IPAM ----------

type Alloc = { addresses: string; used_by: string; type: string; nat: boolean; hwaddr: string; server: string };

// "/1.0/instances/web-01?project=x" -> name "web-01", project "x"
const allocName = (a: Alloc) => decodeURIComponent(a.used_by.split("?")[0].split("/").pop() || "");
const allocProject = (a: Alloc) => new URLSearchParams(a.used_by.split("?")[1] || "").get("project") || "default";

export function Ipam() {
  useCrumbs([{ label: "Networking" }, { label: "IPAM" }]);
  const multi = useApp().servers.length > 1;
  const servers = useScopedServers();
  const names = servers.map((s) => s.name).join(",");
  const q = useData<Alloc[]>(names ? `ipam:${names}` : null, async () =>
    (await Promise.all(servers.map(async (s) => ((await incus<Alloc[]>(s.name, "/1.0/network-allocations?all-projects=true")) || []).map((a) => ({ ...a, server: s.name }))))).flat(),
  );
  const [search, setSearch] = useState("");
  const [fam, setFam] = useState<"all" | "4" | "6">("all");
  const rows = q.data?.filter((a) => (fam === "all" || (fam === "4" ? !a.addresses.includes(":") : a.addresses.includes(":"))) && matches(search, a.addresses, allocName(a), a.type, a.hwaddr));
  return (
    <>
      <PageHead title="IPAM" />
      <div className="fbar">
        <Search value={search} onChange={setSearch} placeholder="Filter by address or name" />
        <Seg value={fam} onChange={setFam} label="Address family" options={[{ v: "all", l: "All" }, { v: "4", l: "IPv4" }, { v: "6", l: "IPv6" }]} />
        <span className="dim fnote">Every address Incus handed out, across projects.</span>
      </div>
      <Table<Alloc>
        rows={rows}
        loading={q.loading}
        rowKey={(a) => a.server + a.addresses + a.used_by}
        empty={q.error || "No addresses in use."}
        cols={[
          { k: "addr", label: "Address", sort: (a) => a.addresses, cell: (a) => <span className="mono">{a.addresses}</span> },
          { k: "used", label: "Used by", sort: (a) => allocName(a), cell: (a) => <span className="nm"><span className="nm2">{allocName(a)}</span><small className="dim">{a.type}</small></span> },
          { k: "nat", label: "NAT", sort: (a) => String(a.nat), cell: (a) => (a.nat ? "yes" : "no"), cls: "hide-s" },
          { k: "mac", label: "MAC", sort: (a) => a.hwaddr, cell: (a) => <span className="mono dim">{a.hwaddr || "–"}</span>, cls: "hide-m" },
          { k: "project", label: "Project", sort: (a) => allocProject(a), cell: (a) => allocProject(a), cls: "hide-m" },
          ServerCol<Alloc>(multi),
        ]}
      />
    </>
  );
}
