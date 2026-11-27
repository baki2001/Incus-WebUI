import { incus, incusOp, type Instance } from "./api";
import { useEffect, useState } from "react";
import { useApp, useData, useScopedServers } from "./state";

export type Row = Instance & { server: string };

// All instances in the current scope (one or all servers), with state.
export function useInstances(interval = 5000) {
  const { project } = useApp();
  const servers = useScopedServers();
  const names = servers.map((s) => s.name).join(",");
  const key = names ? `instances:${names}:${project}` : null;
  const q = useData<Row[]>(
    key,
    async () => {
      const all = await Promise.all(
        servers.map(async (s) => {
          const path = project === "*" ? "/1.0/instances?recursion=2&all-projects=true" : "/1.0/instances?recursion=2";
          const list = await incus<Instance[]>(s.name, path, { project: project === "*" ? undefined : project }).catch(() => [] as Instance[]);
          return list.map((i) => ({ ...i, server: s.name }));
        }),
      );
      return all.flat().sort((a, b) => a.name.localeCompare(b.name));
    },
    interval,
  );
  return { ...q, key };
}

export function useProjects() {
  const servers = useScopedServers();
  const names = servers.map((s) => s.name).join(",");
  return useData<string[]>(names ? `projects:${names}` : null, async () => {
    const all = await Promise.all(servers.map((s) => incus<string[]>(s.name, "/1.0/projects").catch(() => [] as string[])));
    return [...new Set(all.flat().map((p) => p.split("/").pop()!))].sort();
  });
}

export function projectFor(row: { project?: string }, project: string) {
  return project === "*" ? row.project || "default" : project;
}

// Pinned instances, shown nested under Instances in the sidebar. Kept in this
// browser only.
export type Pin = { server: string; name: string; project: string };
const pinSubs = new Set<() => void>();
export function pins(): Pin[] {
  try {
    return JSON.parse(localStorage.getItem("iwui.pins") || "[]");
  } catch {
    return [];
  }
}
export function isPinned(p: Pin) {
  return pins().some((x) => x.server === p.server && x.name === p.name && x.project === p.project);
}
export function togglePin(p: Pin) {
  const list = pins();
  const next = isPinned(p) ? list.filter((x) => !(x.server === p.server && x.name === p.name && x.project === p.project)) : [...list, p];
  try {
    localStorage.setItem("iwui.pins", JSON.stringify(next));
  } catch {
    /* ignore */
  }
  pinSubs.forEach((f) => f());
}
export function usePins() {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((n) => n + 1);
    pinSubs.add(f);
    return () => void pinSubs.delete(f);
  }, []);
  return pins();
}

// One Incus collection across the servers in scope, each row tagged with its server.
export function useCollection<T>(name: string, path: string | ((server: string) => string), interval = 0) {
  const { project } = useApp();
  const servers = useScopedServers();
  const names = servers.map((s) => s.name).join(",");
  const p = project === "*" ? "default" : project;
  return useData<(T & { server: string })[]>(
    names ? `${name}:${names}:${p}` : null,
    async () => {
      const all = await Promise.all(
        servers.map(async (s) => {
          const list = await incus<T[]>(s.name, typeof path === "string" ? path : path(s.name), { project: p });
          return (list || []).map((x) => ({ ...x, server: s.name }));
        }),
      );
      return all.flat();
    },
    interval,
  );
}

// Incus has no endpoint for every volume at once, so walk the pools.
export async function listVolumes<T = any>(server: string, project: string) {
  const pools = (await incus<string[]>(server, "/1.0/storage-pools", { project })) || [];
  const per = await Promise.all(
    pools.map(async (u) => {
      const pool = decodeURIComponent(u.split("/").pop() || "");
      const vols = (await incus<any[]>(server, `/1.0/storage-pools/${encodeURIComponent(pool)}/volumes?recursion=1`, { project })) || [];
      return vols.map((v) => ({ ...v, pool }) as T & { pool: string });
    }),
  );
  return per.flat();
}

export function useCurrentProject() {
  const { project } = useApp();
  return project === "*" ? "default" : project;
}

// Names of a server's networks, pools or profiles, for pickers.
export function useNames(server: string, what: "networks" | "storage-pools" | "profiles" | "projects", project?: string) {
  return useData<string[]>(server ? `names:${what}:${server}:${project || ""}` : null, async () =>
    ((await incus<string[]>(server, "/1.0/" + what, { project })) || []).map((p) => decodeURIComponent(p.split("?")[0].split("/").pop()!)),
  );
}

// Managed networks only (bridges, OVN...), not host interfaces.
export type ManagedNet = { name: string; type: string };
export function useManagedNetworks(server: string, project?: string) {
  return useData<ManagedNet[]>(server ? `managednets:${server}:${project || ""}` : null, async () =>
    ((await incus<any[]>(server, "/1.0/networks?recursion=1", { project })) || []).filter((n) => n.managed).map((n) => ({ name: n.name as string, type: n.type as string })),
  );
}

// GET /1.0 for one server, cached.
export type ServerInfo = { api_extensions?: string[]; environment?: Record<string, any>; [k: string]: any };
export function useServerInfo(server: string) {
  return useData<ServerInfo>(server ? `serverinfo:${server}` : null, () => incus<ServerInfo>(server, "/1.0"));
}
export function hasExt(info: ServerInfo | undefined, name: string) {
  return !!info?.api_extensions?.includes(name);
}

export function nameOf(url: string) {
  return decodeURIComponent(url.split("?")[0].split("/").pop() || "");
}

// "used_by" URLs → short labels like "instance web-01" or "profile default"
export function usedByLabels(list: string[] | undefined) {
  return (list || []).map((u) => {
    const parts = u.split("?")[0].split("/");
    const kind = parts[2] || "";
    const name = decodeURIComponent(parts[parts.length - 1]);
    const k = { instances: "instance", profiles: "profile", networks: "network", "storage-pools": "volume", projects: "project" }[kind] || kind;
    const proj = /project=([^&]+)/.exec(u)?.[1];
    return { kind: k, name, project: proj ? decodeURIComponent(proj) : "default", url: u };
  });
}

// Non-cloud VM images boot their agent from a small config disk. Incus creates
// those VMs fine but won't start them without one ("requires an agent:config
// disk be added"), so add it before we start them.
const isAgentDisk = (d: any) => d?.type === "disk" && d.source === "agent:config";
export const needsAgentDisk = (e: unknown) => /agent:config/i.test(e instanceof Error ? e.message : String(e));
export function withAgentDisk<T extends Record<string, any>>(devices: T, taken: Record<string, any> = devices): T {
  if (Object.values(taken).some(isAgentDisk) || Object.values(devices).some(isAgentDisk)) return devices;
  let n = "agent";
  for (let i = 1; taken[n] || devices[n]; i++) n = `agent${i}`;
  return { ...devices, [n]: { type: "disk", source: "agent:config" } };
}

// addAgentDisk adds the agent disk when the instance's image asks for one and it
// has none yet, from its own config or a profile. Returns true if it added one.
export async function addAgentDisk(server: string, project: string | undefined, name: string) {
  const path = `/1.0/instances/${encodeURIComponent(name)}`;
  const inst = await incus<any>(server, path, { project });
  if (inst?.type !== "virtual-machine" || inst.config?.["image.requirements.cdrom_agent"] !== "true") return false;
  const devices = inst.devices || {};
  const next = withAgentDisk(devices, { ...inst.expanded_devices, ...devices });
  if (next === devices) return false;
  await incusOp(server, path, { method: "PATCH", project, body: { devices: next } });
  return true;
}

// setState changes an instance's state. A start that fails only for a missing
// agent disk adds the disk and tries again.
export async function setState(server: string, project: string | undefined, name: string, body: { action: string; [k: string]: unknown }, onProgress?: (d: string) => void) {
  const put = () => incusOp(server, `/1.0/instances/${encodeURIComponent(name)}/state`, { method: "PUT", project, body }, onProgress);
  try {
    return await put();
  } catch (e) {
    if (!/^(start|restart)$/.test(body.action) || !needsAgentDisk(e) || !(await addAgentDisk(server, project, name).catch(() => false))) throw e;
    return put();
  }
}
