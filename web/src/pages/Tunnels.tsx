import { useEffect, useMemo, useState } from "react";
import "./tunnels.css";
import { bytes, incus, ui } from "../api";
import { ic } from "../icons";
import { useCrumbs } from "../Shell";
import { invalidate, useApp, useData, useScopedServers } from "../state";
import { useCurrentProject, useInstances } from "../data";
import { confirmDialog, CopyBtn, Dialog, Empty, Field, Input, Menu, Select, Sheet, SheetSec } from "../ui";
import { PageHead, Search, matches } from "./Resource";
import { genKeyPair, genPSK, qrPath } from "./tunnelkit";

type Peer = { name: string; publicKey: string; endpoint: string; allowedIPs: string[]; latestHandshake: number; rx: number; tx: number };
type Tunnel = {
  server: string;
  project: string;
  instance: string;
  iface: string;
  listenPort: number;
  managed: boolean;
  kind: "remote-access" | "vps" | "monitor";
  status: string;
  up: boolean;
  error?: string;
  endpoint?: string;
  address?: string;
  routes?: string[];
  publicKey?: string;
  peers: Peer[];
};

const kindLabel = { "remote-access": "Remote access", vps: "Homelab to VPS", monitor: "Monitored" } as const;
const STALE_SECS = 180;

function ago(secs: number) {
  if (secs < 5) return "just now";
  if (secs < 60) return `${Math.floor(secs)} s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)} h ago`;
  return `${Math.floor(secs / 86400)} d ago`;
}

function download(name: string, text: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const fileSafe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "device";

export function Tunnels() {
  useCrumbs([{ label: "Networking" }, { label: "Tunnels" }]);
  const app = useApp();
  const q = useData<Tunnel[]>("tunnels", () => ui<Tunnel[]>("/tunnels"), 5000);
  const [wizard, setWizard] = useState<"" | "remote" | "vps" | "monitor">("");
  const [addTo, setAddTo] = useState<Tunnel | null>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const list = q.data;
  const multi = app.servers.length > 1;

  const remove = async (t: Tunnel) => {
    const mon = t.kind === "monitor";
    const ok = await confirmDialog({
      title: mon ? `Stop monitoring ${t.instance}?` : `Delete ${t.instance}?`,
      body: mon ? "The instance isn't changed. It just disappears from this page." : "This deletes the gateway instance and its keys. Every device that uses this tunnel stops working.",
      confirm: mon ? "Stop monitoring" : "Delete gateway",
      danger: !mon,
    });
    if (!ok) return;
    const done = await app.run(mon ? `Removing ${t.instance}` : `Deleting ${t.instance}`, () => ui(`/tunnels/${enc(t)}`, { method: "DELETE" }).then(() => true), mon ? "No longer monitored" : `${t.instance} deleted`);
    if (done) invalidate("tunnels");
  };
  const retry = async (t: Tunnel) => {
    const ok = await app.run(`Starting ${t.iface}`, () => ui(`/tunnels/${enc(t)}/restart?iface=${encodeURIComponent(t.iface)}`, { method: "POST" }).then(() => true), `${t.iface} is up`);
    if (ok !== undefined) invalidate("tunnels");
  };
  const revoke = async (t: Tunnel, p: Peer) => {
    const ok = await confirmDialog({ title: `Remove ${p.name || "this device"}?`, body: "It is cut off right away and can't connect again. You can add it again with a new key.", confirm: "Remove device", danger: true });
    if (!ok) return;
    const done = await app.run(`Removing ${p.name || "device"}`, () => ui(`/tunnels/${enc(t)}/peers?iface=${encodeURIComponent(t.iface)}&key=${encodeURIComponent(p.publicKey)}`, { method: "DELETE" }).then(() => true), "Device removed");
    if (done) invalidate("tunnels");
  };

  return (
    <>
      <PageHead title="Tunnels">
        <Menu button={(p) => <button className="btn btn-p press" {...p}>{ic.plus}Add tunnel</button>}>
          {(close) => (
            <>
              <button onClick={() => { close(); setWizard("remote"); }}>Remote access</button>
              <button onClick={() => { close(); setWizard("vps"); }}>Homelab to VPS</button>
              <button onClick={() => { close(); setWizard("monitor"); }}>Monitor an existing tunnel</button>
            </>
          )}
        </Menu>
      </PageHead>

      {q.error && !list && <div className="panel" style={{ padding: 16 }}>{q.error}</div>}
      {list && list.length === 0 && (
        <div className="panel">
          <Empty title="No tunnels yet">WireGuard runs in a small gateway instance, never on the host. Pick what you want to do.</Empty>
          <div className="tn-start">
            <button className="press" onClick={() => setWizard("remote")}>
              <b>Remote access</b>
              <span>Reach your homelab from a laptop or phone.</span>
            </button>
            <button className="press" onClick={() => setWizard("vps")}>
              <b>Homelab to VPS</b>
              <span>Your homelab dials out to a VPS. No port opens at home.</span>
            </button>
            <button className="press" onClick={() => setWizard("monitor")}>
              <b>Monitor an existing tunnel</b>
              <span>Watch a WireGuard instance you already run.</span>
            </button>
          </div>
        </div>
      )}
      {list?.map((t) => (
        <TunnelPanel key={t.server + t.project + t.instance + t.iface} t={t} multi={multi} onAdd={() => setAddTo(t)} onRemove={() => remove(t)} onRetry={() => retry(t)} onRevoke={(p) => revoke(t, p)} />
      ))}

      <RemoteWizard open={wizard === "remote"} onClose={() => setWizard("")} onAdd={(t) => { setWizard(""); setAddTo(t); }} />
      <VpsWizard open={wizard === "vps"} onClose={() => setWizard("")} />
      <MonitorWizard open={wizard === "monitor"} onClose={() => setWizard("")} watched={list || []} />
      <AddDevice t={addTo} onClose={() => setAddTo(null)} />
    </>
  );
}

const enc = (t: { server: string; project: string; instance: string }) => [t.server, t.project, t.instance].map(encodeURIComponent).join("/");

function TunnelPanel({ t, multi, onAdd, onRemove, onRetry, onRevoke }: { t: Tunnel; multi: boolean; onAdd: () => void; onRemove: () => void; onRetry: () => void; onRevoke: (p: Peer) => void }) {
  const now = Date.now() / 1000;
  const noIface = !t.iface;
  return (
    <div className="panel tn">
      <div className="ptitle">
        <h2>{t.instance}</h2>
        <span className="tn-kind">{kindLabel[t.kind]}</span>
        <span className={"st " + (t.up ? "running" : "error")}>{t.up ? "Up" : "Down"}</span>
        <span className="r tn-act">
          {t.kind === "remote-access" && (
            <button className="btn btn-s btn-sm press" onClick={onAdd}>
              {ic.plus}Add device
            </button>
          )}
          {t.managed && !t.up && t.status === "Running" && !noIface && (
            <button className="btn btn-s btn-sm press" onClick={onRetry}>
              Try again
            </button>
          )}
          <button className="btn btn-q btn-sm press" onClick={onRemove} aria-label={t.kind === "monitor" ? "Stop monitoring" : "Delete gateway"} title={t.kind === "monitor" ? "Stop monitoring" : "Delete gateway"}>
            {ic.trash}
            <span className="tn-lbl">{t.kind === "monitor" ? "Stop monitoring" : "Delete"}</span>
          </button>
        </span>
      </div>
      <dl className="tn-meta">
        {t.iface && <Meta k="Interface" v={t.iface} />}
        {t.listenPort > 0 && <Meta k="UDP port" v={String(t.listenPort)} />}
        {t.endpoint && <Meta k="Public endpoint" v={t.endpoint} />}
        {t.address && <Meta k="Tunnel address" v={t.address} />}
        {t.routes && t.routes.length > 0 && <Meta k={t.kind === "vps" ? "Reachable from the VPS" : "Devices can reach"} v={t.routes.join(", ")} />}
        {multi && <Meta k="Server" v={t.server} plain />}
        {t.project !== "default" && <Meta k="Project" v={t.project} plain />}
      </dl>
      {t.error && <div className="tn-err">{t.error}</div>}
      {t.peers.length > 0 ? (
        <div className="tn-peers" role="table" aria-label={`Peers of ${t.instance}`}>
          <div className="tn-peer tn-head" role="row">
            <span>Peer</span>
            <span>Last handshake</span>
            <span>Traffic</span>
            <span />
          </div>
          {t.peers.map((p) => {
            const age = p.latestHandshake ? now - p.latestHandshake : -1;
            const stale = age > STALE_SECS;
            return (
              <div className="tn-peer" role="row" key={p.publicKey}>
                <span className="tn-pn">
                  <b>{p.name || "Unnamed"}</b>
                  <small className="mono dim">{p.allowedIPs.join(", ") || "–"}</small>
                </span>
                <span className={"tn-hs" + (stale ? " warn" : "")} title={p.endpoint ? `from ${p.endpoint}` : undefined}>
                  {age < 0 ? <span className="dim">No handshake yet</span> : ago(Math.max(age, 0))}
                  {stale && <small>Silent for a while</small>}
                </span>
                <span className="tn-tr mono" title="Download and upload, seen from the device">
                  ↓ {bytes(p.tx)} <span className="dim">↑ {bytes(p.rx)}</span>
                </span>
                <span className="tn-x">
                  {t.kind === "remote-access" && (
                    <button className="btn btn-q btn-sm press" onClick={() => onRevoke(p)} aria-label={`Remove ${p.name || "device"}`} title="Remove device">
                      {ic.x}
                    </button>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        !t.error && <div className="tn-none dim">{t.kind === "remote-access" ? "No devices yet. Add one to get a QR code for your phone or a config file for your laptop." : "No peers."}</div>
      )}
    </div>
  );
}

function Meta({ k, v, plain }: { k: string; v: string; plain?: boolean }) {
  return (
    <div>
      <dt>{k}</dt>
      <dd className={plain ? undefined : "mono"}>{v}</dd>
    </div>
  );
}

// ---------- shared wizard pieces ----------

type Image = { fingerprint: string; type?: string; aliases?: { name: string }[]; properties?: Record<string, string> };
type Net = { name: string; type: string; managed: boolean; config: Record<string, string> };

function useWizardData(open: boolean, server: string, project: string) {
  const imgs = useData<Image[]>(open && server ? `tunnel-images:${server}:${project}` : null, () => incus<Image[]>(server, "/1.0/images?recursion=1", { project }));
  const nets = useData<Net[]>(open && server ? `tunnel-nets:${server}:${project}` : null, () => incus<Net[]>(server, "/1.0/networks?recursion=1", { project }));
  const images = useMemo(() => {
    const out: { v: string; l: string }[] = [];
    for (const i of imgs.data || []) {
      if (i.type && i.type !== "container") continue;
      const name = i.aliases?.[0]?.name;
      const os = (i.properties?.os || "").toLowerCase();
      const hay = (name || os).toLowerCase();
      if (!/^(alpine|debian|ubuntu)/.test(hay) && !/^(alpine|debian|ubuntu)$/.test(os)) continue;
      out.push({ v: name || i.fingerprint, l: name ? `${name}${i.properties?.description ? " – " + i.properties.description : ""}` : i.properties?.description || i.fingerprint.slice(0, 12) });
    }
    const rank = (s: string) => ["alpine", "debian", "ubuntu"].findIndex((p) => s.toLowerCase().startsWith(p));
    return out.sort((a, b) => rank(a.l) - rank(b.l) || a.l.localeCompare(b.l));
  }, [imgs.data]);
  const networks = useMemo(() => (nets.data || []).filter((n) => n.managed && n.type === "bridge" && n.config["ipv4.address"] && n.config["ipv4.address"] !== "none"), [nets.data]);
  return { images, networks, loading: imgs.loading || nets.loading };
}

function NetworkPicker({ networks, value, onChange }: { networks: Net[]; value: string[]; onChange: (v: string[]) => void }) {
  if (!networks.length) return <div className="dim" style={{ fontSize: 13 }}>No managed bridge networks with an IPv4 address on this server.</div>;
  return (
    <div className="tn-nets">
      {networks.map((n) => (
        <label key={n.name} className="tn-chk">
          <input type="checkbox" checked={value.includes(n.name)} onChange={(e) => onChange(e.target.checked ? [...value, n.name] : value.filter((x) => x !== n.name))} />
          <span>{n.name}</span>
          <span className="mono dim">{n.config["ipv4.address"]}</span>
        </label>
      ))}
    </div>
  );
}

function ServerPick({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const servers = useScopedServers();
  if (servers.length < 2) return null;
  return (
    <Field label="Server">
      <Select value={value} onChange={onChange} options={servers.map((s) => s.name)} />
    </Field>
  );
}

function useWizardState(open: boolean) {
  const servers = useScopedServers();
  const project = useCurrentProject();
  const [server, setServer] = useState("");
  const srv = server || servers[0]?.name || "";
  const data = useWizardData(open, srv, project);
  const [image, setImage] = useState("");
  const [nets, setNets] = useState<string[]>([]);
  // pick sensible defaults once the lists arrive
  const img = image && data.images.some((i) => i.v === image) ? image : data.images[0]?.v || "";
  const picked = nets.filter((n) => data.networks.some((x) => x.name === n));
  const netSel = picked.length ? picked : data.networks[0] ? [data.networks.find((n) => n.name === "incusbr0")?.name || data.networks[0].name] : [];
  return { srv, setServer, project, image: img, setImage, nets: netSel, setNets, ...data };
}

async function createGateway(body: Record<string, unknown>) {
  return ui<any>("/tunnels", { method: "POST", body });
}

const portOK = (s: string) => /^\d+$/.test(s) && +s >= 1 && +s <= 65535;
// a public IP address or a DNS name (not "localhost")
const hostOK = (s: string) => (/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(s) && s.includes(".")) || /^[0-9a-fA-F]*:[0-9a-fA-F:]*:[0-9a-fA-F]*$/.test(s);

function ImagePick({ images, value, onChange, loading }: { images: { v: string; l: string }[]; value: string; onChange: (v: string) => void; loading: boolean }) {
  return (
    <Field label="Image" hint={!images.length && !loading ? "No Alpine, Debian or Ubuntu container image on this server. Pull one on the Images page first." : "The gateway installs WireGuard from the image's package manager."} bad={!images.length && !loading}>
      <Select value={value} onChange={onChange} options={images.length ? images : [{ v: "", l: loading ? "Loading…" : "No suitable image" }]} />
    </Field>
  );
}

// ---------- wizard 1: remote access ----------

function RemoteWizard({ open, onClose, onAdd }: { open: boolean; onClose: () => void; onAdd: (t: Tunnel) => void }) {
  const w = useWizardState(open);
  const [name, setName] = useState("wg-gateway");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("51820");
  const [subnet, setSubnet] = useState("10.66.0.0/24");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [res, setRes] = useState<any>(null);
  useEffect(() => {
    if (open) {
      setErr("");
      setRes(null);
    }
  }, [open]);
  const valid = hostOK(host.trim());
  const can = !!w.image && w.nets.length > 0 && valid && portOK(port) && /^[a-zA-Z0-9-]+$/.test(name) && !busy;

  const go = async () => {
    setBusy(true);
    setErr("");
    try {
      const r = await createGateway({ kind: "remote-access", server: w.srv, project: w.project, instance: name, image: w.image, networks: w.nets, host: host.trim(), port: +port, subnet });
      setRes(r);
      invalidate("tunnels");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const close = () => !busy && onClose();

  return (
    <Sheet
      open={open}
      onClose={close}
      title="Remote access"
      footer={
        res ? (
          <>
            <button className="btn btn-s press tn-fb" onClick={onClose}>
              Done
            </button>
            <button className="btn btn-p press tn-fb" onClick={() => onAdd({ server: res.server, project: res.project, instance: res.instance, iface: res.iface } as Tunnel)}>
              Add a device
            </button>
          </>
        ) : (
          <>
            {busy && <span className="dim tn-busy">Creating the gateway. This takes about a minute.</span>}
            <button className="btn btn-s press tn-fb" onClick={close} disabled={busy}>
              Cancel
            </button>
            <button className="btn btn-p press tn-fb" onClick={go} disabled={!can}>
              Create gateway
            </button>
          </>
        )
      }
    >
      <div className="tn-form">
      {res ? (
        <>
          <p className="tn-p">
            Gateway <b>{res.instance}</b> is created. {res.up ? "WireGuard is running." : "WireGuard is installed but isn't running yet."}
          </p>
          {!res.up && <div className="tn-err">{res.error}</div>}
          <p className="tn-p dim">Next, add your first device. Its private key is made in this browser and never reaches the server.</p>
        </>
      ) : (
        <>
          <p className="tn-p dim">Reach your homelab from a laptop or phone. A small gateway instance runs WireGuard and only lets devices reach the networks you pick.</p>
          <ServerPick value={w.srv} onChange={w.setServer} />
          <SheetSec title="Reachable networks">
            <NetworkPicker networks={w.networks} value={w.nets} onChange={w.setNets} />
            <div className="hint dim tn-h">Devices can only reach these networks, not the rest of your LAN. The gateway joins each one.</div>
          </SheetSec>
          <SheetSec title="Public address">
            <Field label="IP address or DNS name" hint="What your devices connect to from outside. A dynamic DNS name works." bad={!!host && !valid}>
              <Input value={host} onChange={setHost} placeholder="vpn.example.com" autoCapitalize="none" spellCheck={false} />
            </Field>
            <Field label="UDP port" hint="Forward this port on your router to this machine." bad={!portOK(port)}>
              <Input value={port} onChange={setPort} inputMode="numeric" mono />
            </Field>
          </SheetSec>
          <SheetSec title="Gateway">
            <Field label="Name">
              <Input value={name} onChange={setName} />
            </Field>
            <ImagePick images={w.images} value={w.image} onChange={w.setImage} loading={w.loading} />
            <Field label="Tunnel subnet" hint="Devices get one address each from this range.">
              <Input value={subnet} onChange={setSubnet} mono />
            </Field>
          </SheetSec>
          {err && <div className="tn-err">{err}</div>}
        </>
      )}
      </div>
    </Sheet>
  );
}

// ---------- add device (keys are made here) ----------

function QR({ text }: { text: string }) {
  const q = useMemo(() => {
    try {
      return qrPath(text);
    } catch {
      return null;
    }
  }, [text]);
  if (!q) return <div className="dim">This config is too long for a QR code. Use the file instead.</div>;
  return (
    <svg className="tn-qr" viewBox={`0 0 ${q.size} ${q.size}`} role="img" aria-label="QR code with the device config" shapeRendering="crispEdges">
      <rect width={q.size} height={q.size} fill="#fff" />
      <path d={q.d} fill="#000" />
    </svg>
  );
}

function AddDevice({ t, onClose }: { t: Tunnel | null; onClose: () => void }) {
  const app = useApp();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [conf, setConf] = useState("");
  const [showText, setShowText] = useState(false);
  useEffect(() => {
    if (t) {
      setName("");
      setErr("");
      setConf("");
      setShowText(false);
    }
  }, [t]);
  const okName = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,31}$/.test(name);

  const go = async () => {
    if (!t) return;
    setBusy(true);
    setErr("");
    try {
      const kp = await genKeyPair();
      const psk = genPSK();
      const r = await ui<{ config: string }>(`/tunnels/${enc(t)}/peers?iface=${encodeURIComponent(t.iface || "wg0")}`, { method: "POST", body: { name, publicKey: kp.pub, presharedKey: psk } });
      setConf(r.config.replace("@PRIVATE_KEY@", kp.priv).replace("@PRESHARED_KEY@", psk));
      invalidate("tunnels");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    setConf("");
    onClose();
  };

  return (
    <Dialog open={!!t} onClose={close} size="md">
      <div className="dlg-b tn-dlg">
        <h2>{conf ? `${name} is ready` : "Add a device"}</h2>
        {!conf ? (
          <>
            <p>The private key is made in your browser. The server only gets the public key.</p>
            <Field label="Device name" hint="For example laptop or Anna's phone." bad={!!name && !okName}>
              <Input value={name} onChange={setName} onKeyDown={(e) => e.key === "Enter" && okName && !busy && go()} autoFocus />
            </Field>
            {err && <div className="tn-err">{err}</div>}
          </>
        ) : (
          <>
            <p>Scan this with the WireGuard app, or download the file. This is the only time the private key is shown.</p>
            <QR text={conf} />
            <div className="tn-row">
              <button className="btn btn-p press" onClick={() => download(`${fileSafe(name)}.conf`, conf)}>
                {ic.dl}Download .conf
              </button>
              <button className="btn btn-s press" onClick={() => navigator.clipboard?.writeText(conf).then(() => app.toast("Copied"))}>
                {ic.copy}Copy
              </button>
              <button className="btn btn-q press" onClick={() => setShowText((s) => !s)}>
                {showText ? "Hide" : "Show"} config
              </button>
            </div>
            {showText && <pre className="tn-pre">{conf}</pre>}
          </>
        )}
      </div>
      <div className="dlg-f">
        <button className="btn btn-s press tn-fb" onClick={close}>
          {conf ? "Done" : "Cancel"}
        </button>
        {!conf && (
          <button className="btn btn-p press tn-fb" onClick={go} disabled={!okName || busy}>
            {busy ? "Creating…" : "Create device"}
          </button>
        )}
      </div>
    </Dialog>
  );
}

// ---------- wizard 2: homelab to VPS ----------

type Rule = { proto: "tcp" | "udp"; port: string; ip: string; targetPort: string };

function VpsWizard({ open, onClose }: { open: boolean; onClose: () => void }) {
  const w = useWizardState(open);
  const inst = useInstances(0);
  const [name, setName] = useState("wg-vps-link");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("51820");
  const [subnet, setSubnet] = useState("10.67.0.0/24");
  const [rules, setRules] = useState<Rule[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [res, setRes] = useState<{ conf: string; script: string; up: boolean; error?: string; instance: string } | null>(null);
  useEffect(() => {
    if (open) {
      setErr("");
      setRes(null);
      setRules([]);
    }
  }, [open]);
  const targets = useMemo(
    () =>
      (inst.data || [])
        .filter((i) => i.server === w.srv && i.state?.network)
        .flatMap((i) => Object.values(i.state!.network!).flatMap((n) => n.addresses.filter((a) => a.family === "inet" && a.scope === "global").map((a) => ({ name: i.name, ip: a.address }))))
        .filter((x) => x.name !== name),
    [inst.data, w.srv, name],
  );
  const rulesOK = rules.every((r) => portOK(r.port) && portOK(r.targetPort) && r.ip);
  const valid = hostOK(host.trim());
  const can = !!w.image && w.nets.length > 0 && valid && portOK(port) && /^[a-zA-Z0-9-]+$/.test(name) && rulesOK && !busy;
  const setRule = (i: number, patch: Partial<Rule>) => setRules((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const go = async () => {
    setBusy(true);
    setErr("");
    try {
      // the VPS key pair and the preshared key are made here; only public parts and the preshared key go to the server
      const vps = await genKeyPair();
      const psk = genPSK();
      const r = await createGateway({
        kind: "vps",
        server: w.srv,
        project: w.project,
        instance: name,
        image: w.image,
        networks: w.nets,
        host: host.trim(),
        port: +port,
        subnet,
        vpsPublicKey: vps.pub,
        presharedKey: psk,
        publish: rules.map((x) => ({ proto: x.proto, port: +x.port, targetIP: x.ip, targetPort: +x.targetPort })),
      });
      setRes({ conf: r.vpsConfig.replace("@VPS_PRIVATE_KEY@", vps.priv), script: r.vpsScript.replace("@VPS_PRIVATE_KEY@", vps.priv), up: r.up, error: r.error, instance: r.instance });
      invalidate("tunnels");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    if (busy) return;
    setRes(null);
    onClose();
  };

  return (
    <Sheet
      open={open}
      onClose={close}
      wide
      title="Homelab to VPS"
      footer={
        res ? (
          <button className="btn btn-p press tn-fb" onClick={close}>
            Done
          </button>
        ) : (
          <>
            {busy && <span className="dim tn-busy">Creating the gateway. This takes about a minute.</span>}
            <button className="btn btn-s press tn-fb" onClick={close} disabled={busy}>
              Cancel
            </button>
            <button className="btn btn-p press tn-fb" onClick={go} disabled={!can}>
              Create gateway
            </button>
          </>
        )
      }
    >
      <div className="tn-form">
      {res ? (
        <>
          <p className="tn-p">
            Gateway <b>{res.instance}</b> is created and {res.up ? "dialling out to your VPS as soon as it answers." : "installed, but it isn't running."}
          </p>
          {!res.up && <div className="tn-err">{res.error}</div>}
          <SheetSec
            title="1. Run this on the VPS as root"
            action={
              <>
                <button className="btn btn-q btn-sm press" onClick={() => download("wg-vps-install.sh", res.script)}>
                  {ic.dl}Download
                </button>
                <CopyBtn text={res.script} />
              </>
            }
          >
            <pre className="tn-pre">{res.script}</pre>
          </SheetSec>
          <SheetSec
            title="Or just the config for /etc/wireguard/wg0.conf"
            action={
              <>
                <button className="btn btn-q btn-sm press" onClick={() => download("wg0.conf", res.conf)}>
                  {ic.dl}Download
                </button>
                <CopyBtn text={res.conf} />
              </>
            }
          >
            <pre className="tn-pre">{res.conf}</pre>
          </SheetSec>
          <p className="tn-p dim">The VPS private key is in these texts and nowhere else. Open UDP port {port} on the VPS firewall. The tunnel shows up on this page once the gateway has connected.</p>
        </>
      ) : (
        <>
          <p className="tn-p dim">Your homelab gateway dials out to a VPS with a public IP, so no port opens at home. You get the VPS config and an install script.</p>
          <ServerPick value={w.srv} onChange={w.setServer} />
          <SheetSec title="VPS">
            <Field label="Public IP address or DNS name" hint="Where the gateway connects to." bad={!!host && !valid}>
              <Input value={host} onChange={setHost} placeholder="203.0.113.10" autoCapitalize="none" spellCheck={false} />
            </Field>
            <Field label="UDP port on the VPS" bad={!portOK(port)}>
              <Input value={port} onChange={setPort} inputMode="numeric" mono />
            </Field>
          </SheetSec>
          <SheetSec title="Networks the VPS can reach">
            <NetworkPicker networks={w.networks} value={w.nets} onChange={w.setNets} />
          </SheetSec>
          <SheetSec title="Publish ports through the VPS" action={<button className="btn btn-q btn-sm press" onClick={() => setRules((r) => [...r, { proto: "tcp", port: "", ip: targets[0]?.ip || "", targetPort: "" }])}>{ic.plus}Add port</button>}>
            {rules.length === 0 && <div className="dim tn-h">Optional. Forward a public port on the VPS to a service at home.</div>}
            {rules.map((r, i) => (
              <div className="tn-rule" key={i}>
                <Select value={r.proto} onChange={(v) => setRule(i, { proto: v as Rule["proto"] })} options={["tcp", "udp"]} aria-label="Protocol" />
                <Input value={r.port} onChange={(v) => setRule(i, { port: v })} placeholder="VPS port" inputMode="numeric" mono bad={!!r.port && !portOK(r.port)} aria-label="Public port on the VPS" />
                <Select value={r.ip} onChange={(v) => setRule(i, { ip: v })} options={targets.length ? targets.map((x) => ({ v: x.ip, l: `${x.name} (${x.ip})` })) : [{ v: "", l: "No running instances" }]} aria-label="Instance" />
                <Input value={r.targetPort} onChange={(v) => setRule(i, { targetPort: v })} placeholder="Port" inputMode="numeric" mono bad={!!r.targetPort && !portOK(r.targetPort)} aria-label="Port on the instance" />
                <button className="btn btn-q press tn-rx" onClick={() => setRules((rs) => rs.filter((_, j) => j !== i))} aria-label="Remove this port">
                  {ic.x}
                </button>
              </div>
            ))}
          </SheetSec>
          <SheetSec title="Gateway">
            <Field label="Name">
              <Input value={name} onChange={setName} />
            </Field>
            <ImagePick images={w.images} value={w.image} onChange={w.setImage} loading={w.loading} />
            <Field label="Tunnel subnet" hint="The VPS gets the first address, the gateway the second.">
              <Input value={subnet} onChange={setSubnet} mono />
            </Field>
          </SheetSec>
          {err && <div className="tn-err">{err}</div>}
        </>
      )}
      </div>
    </Sheet>
  );
}

// ---------- wizard 3: monitor ----------

function MonitorWizard({ open, onClose, watched }: { open: boolean; onClose: () => void; watched: Tunnel[] }) {
  const app = useApp();
  const inst = useInstances(0);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState<{ key: string; msg: string } | null>(null);
  useEffect(() => {
    if (open) {
      setErr(null);
      setSearch("");
    }
  }, [open]);
  const done = new Set(watched.map((t) => t.server + "/" + t.project + "/" + t.instance));
  const rows = (inst.data || []).filter((i) => i.status === "Running" && i.type === "container" && !done.has(`${i.server}/${i.project}/${i.name}`) && matches(search, i.name, i.server));

  const watch = async (i: { server: string; project: string; name: string }) => {
    const key = `${i.server}/${i.project}/${i.name}`;
    setBusy(key);
    setErr(null);
    try {
      await ui("/tunnels/watch", { method: "POST", body: { server: i.server, project: i.project, instance: i.name } });
      invalidate("tunnels");
      app.toast(`Monitoring ${i.name}`);
      onClose();
    } catch (e) {
      setErr({ key, msg: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy("");
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Monitor an existing tunnel">
      <div className="tn-form">
      <p className="tn-p dim">Pick an instance that already runs WireGuard. The page shows its peers and traffic. Nothing in the instance is changed.</p>
      <Search value={search} onChange={setSearch} placeholder="Filter instances" />
      <div className="tn-pick">
        {rows.map((i) => {
          const key = `${i.server}/${i.project}/${i.name}`;
          return (
            <div key={key} className="tn-pickrow">
              <span className="tn-pn">
                <b>{i.name}</b>
                <small className="dim">{[i.project !== "default" ? i.project : "", i.server].filter(Boolean).join(" · ")}</small>
                {err?.key === key && <small className="tn-bad">{err.msg}</small>}
              </span>
              <button className="btn btn-s btn-sm press" disabled={!!busy} onClick={() => watch(i)}>
                {busy === key ? "Checking…" : "Monitor"}
              </button>
            </div>
          );
        })}
        {!rows.length && <div className="dim tn-h">{inst.data ? "No running containers to pick." : "Loading…"}</div>}
      </div>
      </div>
    </Sheet>
  );
}

