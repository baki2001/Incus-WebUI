import { useParams } from "react-router-dom";
import { bytes, incus } from "../api";
import { useCrumbs } from "../Shell";
import { useApp, useData } from "../state";

export function Host() {
  const { server = "" } = useParams();
  useCrumbs([{ label: "Hosts" }, { label: server }]);
  const s = useApp().servers.find((x) => x.name === server);
  const ok = !!s?.online && !!s.trusted;
  const info = useData<any>(ok ? `hostinfo:${server}` : null, () => incus(server, "/1.0"));
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
            {s.incus_os && (
              <div className="panel" style={{ padding: 16 }}>
                This host runs IncusOS. Updates and system settings for IncusOS come in a later version of this UI.
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
