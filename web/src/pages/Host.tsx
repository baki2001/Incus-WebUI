import { useState } from "react";
import { useParams } from "react-router-dom";
import { ic } from "../icons";
import { incusOp } from "../api";
import { Field, Input, KVEditor, SheetSec } from "../ui";
import { EditSheet } from "./Resource";
import { bytes, incus } from "../api";
import { useCrumbs } from "../Shell";
import { useApp, useData, cacheGet, invalidate } from "../state";
import { hostBusy, HostUpdates } from "./HostUpdates";

export function Host() {
  const { server = "" } = useParams();
  useCrumbs([{ label: "Hosts" }, { label: server }]);
  const s = useApp().servers.find((x) => x.name === server);
  const ok = !!s?.online && !!s.trusted;
  const prev = cacheGet<any>(`hostinfo:${server}`);
  const info = useData<any>(ok ? `hostinfo:${server}` : null, () => incus(server, "/1.0"), hostBusy(prev?.config) ? 3000 : 0);
  const res = useData<any>(ok ? `res:full:${server}` : null, () => incus(server, "/1.0/resources"), 15000);
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
              </dl>
            </div>
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
