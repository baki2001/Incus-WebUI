import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ic } from "../icons";
import { incusOp } from "../api";
import { Field, Input, KVEditor, SheetSec } from "../ui";
import { EditSheet } from "./Resource";
import { bytes, incus, incusRaw, type Instance } from "../api";
import { useCrumbs } from "../Shell";
import { useApp, useData, cacheGet, invalidate } from "../state";
import { hostBusy, HostUpdates } from "./HostUpdates";

// Incus has no host uptime or load average in its API, so show how long Incus itself has been running.
function dur(sec: number) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
}

type Nic = { name: string; state: string; addrs: string[] };

// Host NICs that are not managed by Incus (the managed bridges show up under Networks).
async function loadNics(server: string): Promise<Nic[]> {
  const nets = ((await incus<any[]>(server, "/1.0/networks?recursion=1").catch(() => [])) || []).filter((n) => !n.managed && n.type !== "loopback");
  return Promise.all(
    nets.map(async (n) => {
      const st = await incus<any>(server, `/1.0/networks/${encodeURIComponent(n.name)}/state`).catch(() => null);
      const addrs = (st?.addresses || []).filter((a: any) => a.scope === "global").map((a: any) => `${a.address}/${a.netmask}`);
      return { name: n.name as string, state: (st?.state as string) || "", addrs };
    }),
  );
}

async function loadPools(server: string) {
  const pools = (await incus<any[]>(server, "/1.0/storage-pools?recursion=1").catch(() => [])) || [];
  return Promise.all(
    pools.map(async (p) => {
      const r = await incus<any>(server, `/1.0/storage-pools/${encodeURIComponent(p.name)}/resources`).catch(() => null);
      return { name: p.name as string, driver: p.driver as string, used: r?.space?.used as number | undefined, total: r?.space?.total as number | undefined };
    }),
  );
}

// Incus leaves the uptime line out of some metrics replies, so ask again a couple of times and keep the last value.
async function loadUptime(server: string): Promise<number | null> {
  for (let i = 0; i < 3; i++) {
    const res = await incusRaw(server, "/1.0/metrics").catch(() => null);
    const m = res?.ok ? /^incus_uptime_seconds\s+([\d.e+]+)/m.exec(await res.text()) : null;
    if (m) return parseFloat(m[1]);
    await new Promise((r) => setTimeout(r, 800));
  }
  return cacheGet<number | null>(`host-uptime:${server}`) ?? null;
}

export function Host() {
  const { server = "" } = useParams();
  useCrumbs([{ label: "Hosts" }, { label: server }]);
  const s = useApp().servers.find((x) => x.name === server);
  const ok = !!s?.online && !!s.trusted;
  const prev = cacheGet<any>(`hostinfo:${server}`);
  const info = useData<any>(ok ? `hostinfo:${server}` : null, () => incus(server, "/1.0"), hostBusy(prev?.config) ? 3000 : 0);
  const res = useData<any>(ok ? `res:full:${server}` : null, () => incus(server, "/1.0/resources"), 15000);
  const nics = useData<Nic[]>(ok ? `host-nics:${server}` : null, () => loadNics(server), 30000);
  const pools = useData<Awaited<ReturnType<typeof loadPools>>>(ok ? `host-pools:${server}` : null, () => loadPools(server), 30000);
  const up = useData<number | null>(ok ? `host-uptime:${server}` : null, () => loadUptime(server), 60000);
  const insts = useData<Instance[]>(ok ? `host-insts:${server}` : null, async () => (await incus<Instance[]>(server, "/1.0/instances?recursion=1&all-projects=true")) || [], 10000);
  const [allInst, setAllInst] = useState(false);
  if (!s) return <div className="dim">Unknown server.</div>;
  const env = info.data?.environment || {};
  const r = res.data;
  return (
    <>
      <div className="ihead">
        <div>
          <h1>
            {server} <span className={"st " + (ok ? "running" : "error")}>{ok ? "Online" : "Offline"}</span>
          </h1>
          <p>
            {s.os || "–"} · Incus {s.version || "–"}
            {s.clustered ? " · clustered" : ""}
          </p>
        </div>
      </div>
      {!ok && <div className="panel" style={{ padding: 16 }}>{s.error}</div>}
      {ok && (
        <div className="dgrid">
          <div className="col">
            <div className="panel">
              <div className="ptitle">
                <h2>Server</h2>
              </div>
              <dl className="kv">
                <dt>Name</dt>
                <dd>{env.server_name}</dd>
                <dt>Operating system</dt>
                <dd>
                  {env.os_name} {env.os_version}
                </dd>
                <dt>Kernel</dt>
                <dd className="mono">{env.kernel_version}</dd>
                <dt>Incus</dt>
                <dd>{env.server_version}</dd>
                <dt>Storage drivers</dt>
                <dd>{env.storage_supported_drivers?.filter((d: any) => !d.remote).map((d: any) => d.Name || d.name).join(", ") || env.storage}</dd>
                <dt>Instance types</dt>
                <dd>{(env.instance_types || []).join(", ") || "container"}</dd>
                <dt>Address</dt>
                <dd className="mono">{(env.addresses || []).join(", ") || s.url}</dd>
                {up.data != null && (
                  <>
                    <dt>Incus running for</dt>
                    <dd>{dur(up.data)}</dd>
                  </>
                )}
              </dl>
            </div>
            {!!nics.data?.length && (
              <div className="panel">
                <div className="ptitle">
                  <h2>Network interfaces</h2>
                </div>
                <dl className="kv">
                  {nics.data.map((n) => (
                    <div key={n.name} style={{ display: "contents" }}>
                      <dt className="mono">{n.name}</dt>
                      <dd className="mono">{n.addrs.join(", ") || <span className="dim">{n.state ? `No address, ${n.state}` : "No address"}</span>}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}
            {!!pools.data?.length && (
              <div className="panel">
                <div className="ptitle">
                  <h2>Storage pools</h2>
                </div>
                <dl className="kv">
                  {pools.data.map((p) => (
                    <div key={p.name} style={{ display: "contents" }}>
                      <dt>
                        {p.name} <span className="dim">({p.driver})</span>
                      </dt>
                      <dd>
                        {p.total ? `${bytes(p.used)} used of ${bytes(p.total)}` : "–"}
                        {!!p.total && (
                          <div className="bar" style={{ marginTop: 6, maxWidth: 260 }} role="img" aria-label={`${Math.round(((p.used || 0) / p.total) * 100)}% used`}>
                            <i className={(p.used || 0) / p.total > 0.9 ? "hot" : ""} style={{ width: `${Math.min(100, ((p.used || 0) / p.total) * 100)}%` }} />
                          </div>
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}
          </div>
          <div className="col">
            <div className="panel">
              <div className="ptitle">
                <h2>Hardware</h2>
              </div>
              <dl className="kv">
                <dt>CPU</dt>
                <dd>
                  {r?.cpu?.sockets?.[0]?.name || "–"} {r ? `· ${r.cpu.total} threads` : ""}
                </dd>
                <dt>Memory</dt>
                <dd>{r ? `${bytes(r.memory.used)} used of ${bytes(r.memory.total)}` : "–"}</dd>
                <dt>GPUs</dt>
                <dd>{r?.gpu?.cards?.map((g: any) => g.product || g.vendor).join(", ") || "None"}</dd>
                <dt>Disks</dt>
                <dd>{r?.storage?.disks?.map((d: any) => `${d.id} (${bytes(d.size, 0)})`).join(", ") || "–"}</dd>
                <dt>Network cards</dt>
                <dd>{r?.network?.cards?.flatMap((c: any) => c.ports?.map((p: any) => p.id) || []).join(", ") || "–"}</dd>
              </dl>
            </div>
            <div className="panel">
              <div className="ptitle">
                <h2>Instances</h2>
                <span className="r dim">{insts.data?.length ?? ""}</span>
              </div>
              {insts.data?.length ? (
                <>
                  <ul className="hostlist">
                    {(allInst ? insts.data : insts.data.slice(0, 8)).map((i) => (
                      <li key={i.project + i.name}>
                        <Link to={`/instances/${server}/${encodeURIComponent(i.name)}?project=${encodeURIComponent(i.project || "default")}`}>{i.name}</Link>
                        <span className="dim">{i.project && i.project !== "default" ? i.project + " · " : ""}{i.status}</span>
                      </li>
                    ))}
                  </ul>
                  {insts.data.length > 8 && (
                    <div className="pfoot">
                      <button className="btn btn-q btn-sm" onClick={() => setAllInst(!allInst)}>
                        {allInst ? "Show fewer" : `Show all ${insts.data.length}`}
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <div className="pfoot" style={{ borderTop: 0 }}>
                  {insts.loading ? "Loading…" : "No instances on this server."}
                </div>
              )}
            </div>
            {info.data && <HostUpdates server={server} incusOS={!!s.incus_os} config={info.data.config || {}} />}
            {info.data && <ServerConfig server={server} config={info.data.config || {}} onSaved={() => info.reload()} />}
          </div>
        </div>
      )}
    </>
  );
}

const serverKeys = [
  "core.https_address", "core.storage_buckets_address", "core.metrics_address", "core.proxy_https", "core.proxy_http", "core.proxy_ignore_hosts", "core.trust_password",
  "images.auto_update_interval", "images.auto_update_cached", "images.remote_cache_expiry", "images.compression_algorithm", "storage.backups_volume", "storage.images_volume",
  "network.ovn.northbound_connection", "instances.placement.scriptlet", "logging.loki.target.address",
];

// Server settings (incus config), with the common ones as fields.
function ServerConfig({ server, config, onSaved }: { server: string; config: Record<string, string>; onSaved: () => void }) {
  const app = useApp();
  const [open, setOpen] = useState(false);
  const shown = Object.entries(config).filter(([k]) => !k.startsWith("user.incus-webui.") && !k.startsWith("volatile."));
  const save = async (d: { config: Record<string, string> }) => {
    // PUT replaces the whole config: keep the UI's own keys as they are.
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(config)) if (k.startsWith("user.incus-webui.")) next[k] = v;
    for (const [k, v] of Object.entries(d.config)) if (k && v !== "") next[k] = v;
    const ok = await app.run("Saving server settings", () => incusOp(server, "/1.0", { method: "PUT", body: { config: next } }).then(() => true), "Server settings saved");
    if (ok) {
      invalidate(`server-info:${server}`);
      onSaved();
    }
    return ok;
  };
  return (
    <div className="panel">
      <div className="ptitle">
        <h2>Configuration</h2>
        <span className="r">
          <button className="btn btn-q btn-sm" onClick={() => setOpen(true)}>
            {ic.edit}Edit
          </button>
        </span>
      </div>
      {shown.length ? (
        <dl className="kv">
          {shown.map(([k, v]) => (
            <div key={k} style={{ display: "contents" }}>
              <dt className="mono" style={{ fontSize: 12 }}>
                {k}
              </dt>
              <dd className="mono" style={{ fontSize: 12.5 }}>
                {k.includes("password") ? "••••••" : v}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <div className="pfoot" style={{ borderTop: 0 }}>
          Everything is at its default.
        </div>
      )}
      <EditSheet<{ config: Record<string, string> }>
        open={open}
        onClose={() => setOpen(false)}
        title={`Settings for ${server}`}
        value={{ config: Object.fromEntries(shown) }}
        onSave={save}
        form={(d, set) => {
          const f = (k: string) => d.config[k] || "";
          const setK = (k: string, v: string) => set((x) => (v ? (x.config[k] = v) : delete x.config[k]));
          return (
            <>
              <div className="two">
                <Field label="API address" hint="Where Incus listens, like :8443. The UI needs it when it runs in a container.">
                  <Input mono value={f("core.https_address")} onChange={(v) => setK("core.https_address", v)} />
                </Field>
                <Field label="Bucket address" hint="For S3 buckets on local pools, like :8555.">
                  <Input mono value={f("core.storage_buckets_address")} onChange={(v) => setK("core.storage_buckets_address", v)} />
                </Field>
                <Field label="Image refresh, hours" hint="How often cached images update. 0 turns it off.">
                  <Input mono value={f("images.auto_update_interval")} onChange={(v) => setK("images.auto_update_interval", v.replace(/\D/g, ""))} placeholder="6" />
                </Field>
                <Field label="Unused cache kept, days" hint="Cached images nothing uses are removed after this.">
                  <Input mono value={f("images.remote_cache_expiry")} onChange={(v) => setK("images.remote_cache_expiry", v.replace(/\D/g, ""))} placeholder="10" />
                </Field>
              </div>
              <SheetSec title="All settings">
                <KVEditor value={d.config} onChange={(c) => set((x) => void (x.config = c))} keys={serverKeys} />
              </SheetSec>
            </>
          );
        }}
      />
    </div>
  );
}
