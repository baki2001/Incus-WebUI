import { useMemo, useState } from "react";
import { bytes, incus, ui } from "../api";
import { ic } from "../icons";
import { useData } from "../state";

export type ImageServer = { name: string; url: string };
export type RemoteImage = { aliases: string[]; os: string; release: string; release_title?: string; variant: string; arch: string; container: boolean; vm: boolean; size: number; updated: string };

export const ociRegistries = [
  { name: "Docker Hub", url: "https://docker.io", hint: "library/nginx:latest" },
  { name: "GitHub", url: "https://ghcr.io", hint: "owner/image:tag" },
  { name: "Quay", url: "https://quay.io", hint: "owner/image:tag" },
];

export function useImageServers() {
  return useData<ImageServer[]>("image-servers", () => ui("/image-servers"));
}

export function useRemoteImages(url: string | undefined) {
  return useData<RemoteImage[]>(url ? `remote-images:${url}` : null, () => ui("/remote-images?server=" + encodeURIComponent(url!)));
}

// Incus reports x86_64 / aarch64; image servers use amd64 / arm64.
const archMap: Record<string, string> = { x86_64: "amd64", aarch64: "arm64", armv7l: "armhf", riscv64: "riscv64", ppc64le: "ppc64el", s390x: "s390x" };
// Instance types the server can run. Newer Incus lists them in
// environment.instance_types; 6.0 LTS doesn't, so read the driver string
// ("lxc | qemu") instead.
export function instanceTypes(env: any): string[] {
  if (Array.isArray(env?.instance_types)) return env.instance_types;
  const d = String(env?.driver || "").split("|").map((x) => x.trim());
  return [d.includes("lxc") && "container", d.includes("qemu") && "virtual-machine"].filter(Boolean) as string[];
}

export function useServerArch(server: string) {
  const q = useData<any>(server ? `server-info:${server}` : null, () => incus(server, "/1.0"));
  const env = q.data?.environment;
  const vm = env ? instanceTypes(env).includes("virtual-machine") : true;
  // Incus explains a missing VM driver in a warning ("KVM support is missing").
  const w = useData<any[]>(server && !vm ? `vm-why:${server}` : null, () => incus(server, "/1.0/warnings?recursion=1"));
  const why = (w.data || []).find((x) => x.type === "Instance type not operational" && /kvm|qemu|virtual/i.test(x.last_message || ""))?.last_message as string | undefined;
  return {
    arch: env ? archMap[env.architectures?.[0]] || env.architectures?.[0] || "amd64" : "",
    vm,
    vmWhy: why,
    info: q.data,
  };
}

// Searchable list of the images on an image server.
export function RemotePicker({ server, type, value, onPick }: { server: string; type: "container" | "virtual-machine" | "any"; value: string; onPick: (alias: string, img: RemoteImage, url: string) => void }) {
  const servers = useImageServers();
  const [which, setWhich] = useState(0);
  const src = servers.data?.[which];
  const list = useRemoteImages(src?.url);
  const { arch } = useServerArch(server);
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return (list.data || []).filter(
      (i) =>
        (!arch || i.arch === arch) &&
        (type === "any" || (type === "container" ? i.container : i.vm)) &&
        words.every((w) => `${i.os} ${i.release} ${i.release_title || ""} ${i.variant} ${i.aliases.join(" ")}`.toLowerCase().includes(w)),
    );
  }, [list.data, arch, type, q]);
  return (
    <div className="ipick">
      <div className="field">
        {ic.search}
        <input placeholder={`Search ${src?.name || "images"}, e.g. debian 13 cloud`} value={q} onChange={(e) => setQ(e.target.value)} />
        {(servers.data?.length || 0) > 1 && (
          <select value={which} onChange={(e) => setWhich(Number(e.target.value))} style={{ flex: "none", width: "auto" }}>
            {servers.data!.map((s, i) => (
              <option key={s.url} value={i}>
                {s.name}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="ilist" role="listbox">
        {list.error && (
          <div className="emp">
            <p style={{ margin: "0 0 10px" }}>{list.error}</p>
            <button type="button" className="btn btn-s btn-sm press" disabled={list.loading} onClick={() => list.reload()}>
              Retry
            </button>
          </div>
        )}
        {!list.data && !list.error && (
          <div style={{ padding: 8, display: "flex", flexDirection: "column", gap: 8 }}>
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className="sk" style={{ height: 22 }} />
            ))}
          </div>
        )}
        {list.data && !shown.length && <div className="emp">Nothing matches.</div>}
        {shown.slice(0, 200).map((i) => (
          <button key={i.aliases[0] + i.arch} type="button" className="iopt" aria-selected={value === i.aliases[0]} onClick={() => onPick(i.aliases[0], i, src!.url)}>
            <span className="os">
              {i.os} {i.release_title && i.release_title !== i.release ? `${i.release} (${i.release_title})` : i.release}
              <small className="mono">{i.aliases[0]}</small>
            </span>
            <span className="tags">
              {i.variant !== "default" && <span className="tag">{i.variant}</span>}
              {i.container && <span className="tag">CT</span>}
              {i.vm && <span className="tag">VM</span>}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function imageName(i: any) {
  return i.aliases?.[0]?.name || i.properties?.description || i.fingerprint?.slice(0, 12) || "";
}

// Picks one of the images already on the server.
export function LocalPicker({ images, type, value, onPick }: { images: any[] | undefined; type: "container" | "virtual-machine"; value: string; onPick: (fp: string) => void }) {
  const [q, setQ] = useState("");
  const ql = q.toLowerCase();
  const shown = (images || []).filter((i) => i.type === type && (!ql || `${imageName(i)} ${i.properties?.description || ""}`.toLowerCase().includes(ql)));
  return (
    <div className="ipick">
      <div className="field">
        {ic.search}
        <input placeholder="Search images on this server" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="ilist" role="listbox">
        {images && !shown.length && <div className="emp">{images.length ? "No images of this type." : "No images on this server yet. Pull one on the Images page."}</div>}
        {shown.map((i) => (
          <button key={i.fingerprint} type="button" className="iopt" aria-selected={value === i.fingerprint} onClick={() => onPick(i.fingerprint)}>
            <span className="os">
              {i.properties?.description || imageName(i)}
              <small className="mono">{imageName(i)}</small>
            </span>
            <span className="tags">
              <span className="tag">{bytes(i.size)}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
