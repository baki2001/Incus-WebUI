import { incus, type Instance } from "./api";
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

// Recently opened instances, shown nested under Instances in the sidebar.
export function recentInstances(): { server: string; name: string; project: string }[] {
  try {
    return JSON.parse(localStorage.getItem("iwui.recent") || "[]");
  } catch {
    return [];
  }
}
export function pushRecent(r: { server: string; name: string; project: string }) {
  const list = recentInstances().filter((x) => !(x.server === r.server && x.name === r.name && x.project === r.project));
  list.unshift(r);
  try {
    localStorage.setItem("iwui.recent", JSON.stringify(list.slice(0, 4)));
  } catch {
    /* ignore */
  }
}
