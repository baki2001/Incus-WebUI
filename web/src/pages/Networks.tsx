import { useState } from "react";
import { incus, incusOp } from "../api";
import { ic } from "../icons";
import { useCrumbs } from "../Shell";
import { invalidate, useApp, useData, useScopedServers } from "../state";
import { useCollection, useCurrentProject } from "../data";
import { confirmDialog, Field, Input, KVEditor, Seg, Select, SheetSec, Table, TglRow, type Col } from "../ui";
import { EditSheet, matches, PageHead, Search, UsedBy } from "./Resource";

type Net = { name: string; type: string; description: string; managed: boolean; status: string; config: Record<string, string>; used_by: string[]; server: string };
type NetPut = { name?: string; type?: string; description: string; config: Record<string, string> };

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
  const q = useCollection<Net>("networks", "/1.0/networks?recursion=1");
  const [search, setSearch] = useState("");
  const [edit, setEdit] = useState<Net | null>(null);
  const [create, setCreate] = useState(false);
  const rows = q.data?.filter((n) => n.managed && matches(search, n.name, n.description, n.config["ipv4.address"], n.type));

  const del = async (n: Net) => {
    if (!(await confirmDialog({ title: `Delete network ${n.name}?`, body: n.used_by?.length ? `${n.used_by.length} instances or profiles still use it; Incus refuses until they don't.` : "Nothing uses it.", confirm: "Delete", danger: true }))) return;
    const ok = await app.run(`Deleting ${n.name}`, () => incusOp(n.server, `/1.0/networks/${encodeURIComponent(n.name)}`, { method: "DELETE", project }).then(() => true), `Network ${n.name} deleted`);
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
          { k: "v4", label: "IPv4", sort: (n) => n.config["ipv4.address"], cell: (n) => <span className="mono">{n.config["ipv4.address"] || "–"}</span>, cls: "hide-s" },
          { k: "v6", label: "IPv6", sort: (n) => n.config["ipv6.address"], cell: (n) => <span className="mono dim">{n.config["ipv6.address"] || "–"}</span>, cls: "hide-m" },
          { k: "status", label: "State", sort: (n) => n.status, cell: (n) => <span className={"st " + (n.status === "Created" ? "running" : n.status === "Pending" ? "busy" : "error")}>{n.status}</span>, cls: "hide-s" },
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
      const ok = await app.run(`Creating ${d.name}`, () => incusOp(srv, "/1.0/networks", { method: "POST", project, body: { ...d, config: clean(d.config) } }).then(() => true), `Network ${d.name} created`);
      if (ok) onSaved();
      return ok;
    }
    const ok = await app.run(`Saving ${net.name}`, () => incusOp(net.server, `/1.0/networks/${encodeURIComponent(net.name)}`, { method: "PUT", project, body: { description: d.description, config: clean(d.config) } }).then(() => true), `Network ${net.name} saved`);
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
        net && leases.data && leases.data.length > 0 ? (
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
        ) : undefined
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
                {(acls.data?.length || 0) > 0 && (
                  <SheetSec title="ACLs">
                    <div className="pt">
                      {acls.data!.map((a) => (
                        <label key={a}>
                          <input type="checkbox" checked={aclList.includes(a)} onChange={(e) => setCfg("security.acls", (e.target.checked ? [...aclList, a] : aclList.filter((x) => x !== a)).join(","))} />
                          {a}
                        </label>
                      ))}
                    </div>
                  </SheetSec>
                )}
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

function clean(c: Record<string, string>) {
  const o: Record<string, string> = {};
  for (const [k, v] of Object.entries(c)) if (k && !k.startsWith("volatile.")) o[k] = v;
  return o;
}

// ---------- ACLs ----------

type Rule = { action: string; state: string; description?: string; source?: string; destination?: string; protocol?: string; source_port?: string; destination_port?: string; icmp_type?: string; icmp_code?: string };
type Acl = { name: string; description: string; ingress: Rule[]; egress: Rule[]; config: Record<string, string>; used_by: string[]; server: string };
type AclPut = { name?: string; description: string; ingress: Rule[]; egress: Rule[]; config: Record<string, string> };

export function Acls() {
  useCrumbs([{ label: "Networking" }, { label: "ACLs" }]);
  const app = useApp();
  const project = useCurrentProject();
  const servers = useScopedServers();
  const multi = app.servers.length > 1;
  const q = useCollection<Acl>("acls", "/1.0/network-acls?recursion=1");
  const [search, setSearch] = useState("");
  const [edit, setEdit] = useState<Acl | null>(null);
  const [create, setCreate] = useState(false);
  const [server, setServer] = useState("");
  const srv = edit?.server || server || servers[0]?.name || "";

  const save = async (d: AclPut) => {
    const body = { ...d, ingress: d.ingress.map(cleanRule), egress: d.egress.map(cleanRule) };
    if (!edit) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(d.name || "")) return void app.toast("Give the ACL a name.");
      const ok = await app.run(`Creating ${d.name}`, () => incusOp(srv, "/1.0/network-acls", { method: "POST", project, body }).then(() => true), `ACL ${d.name} created`);
      if (ok) invalidate("acls:");
      return ok;
    }
    const ok = await app.run(`Saving ${edit.name}`, () => incusOp(edit.server, `/1.0/network-acls/${encodeURIComponent(edit.name)}`, { method: "PUT", project, body: { description: body.description, ingress: body.ingress, egress: body.egress, config: body.config } }).then(() => true), `ACL ${edit.name} saved`);
    if (ok) invalidate("acls:");
    return ok;
  };
  const del = async (a: Acl) => {
    if (!(await confirmDialog({ title: `Delete ACL ${a.name}?`, body: a.used_by?.length ? "Networks or instances still use it; remove it from them first." : "Nothing uses it.", confirm: "Delete", danger: true }))) return;
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
        value={edit ? { description: edit.description, ingress: edit.ingress || [], egress: edit.egress || [], config: edit.config || {} } : create ? { name: "", description: "", ingress: [], egress: [], config: {} } : null}
        onSave={save}
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
            <span className="dim" style={{ fontSize: 12.5 }}>
              Source and destination take addresses, ranges or subnets (comma separated), or another ACL's name. Traffic no rule matches gets the network's default action.
            </span>
          </>
        )}
      />
    </>
  );
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
