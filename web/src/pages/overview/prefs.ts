import { useCallback, useEffect, useState } from "react";
import { ui } from "../../api";

export type Size = "s" | "m";
export type Item = { id: string; on: boolean; size?: Size };

export const ELEMENTS: { id: string; title: string; note: string; sizes?: boolean }[] = [
  { id: "capacity", title: "Capacity", note: "CPU, memory and storage per server" },
  { id: "snapshots", title: "Snapshots", note: "Which instances have missed their snapshot schedule", sizes: true },
  { id: "timeline", title: "Next 24 hours", note: "Snapshot runs, expiries and image refresh" },
  { id: "addresses", title: "Addresses", note: "Used and free IPv4 addresses per network", sizes: true },
  { id: "tunnels", title: "Tunnels", note: "WireGuard peers. Hidden when there are none", sizes: true },
  { id: "exposure", title: "Exposure", note: "Open ports, privileged containers, nesting, API address" },
  { id: "ports", title: "Open ports", note: "Proxy devices and network forwards" },
  { id: "boot", title: "Boot order", note: "What starts on boot, and in which order" },
  { id: "pinned", title: "Pinned", note: "Your pinned instances. Hidden when you have none" },
  { id: "images", title: "Base images", note: "How old the images your instances came from are" },
];

export const DEFAULTS: Item[] = ELEMENTS.map((e) => ({ id: e.id, on: e.id !== "images", ...(e.sizes ? { size: "m" as Size } : {}) }));

// Saved items first (in their order), then any element the saved list does not know yet.
export function normalise(saved: unknown): Item[] {
  const out: Item[] = [];
  if (Array.isArray(saved))
    for (const s of saved) {
      const def = DEFAULTS.find((d) => d.id === s?.id);
      if (!def || out.some((o) => o.id === def.id)) continue;
      out.push({ id: def.id, on: !!s.on, ...(def.size ? { size: s.size === "s" ? "s" : "m" } : {}) });
    }
  for (const d of DEFAULTS) if (!out.some((o) => o.id === d.id)) out.push({ ...d });
  return out;
}

const LS = "iwui.dashboard";
function local(): Item[] {
  try {
    return normalise(JSON.parse(localStorage.getItem(LS) || "null"));
  } catch {
    return normalise(null);
  }
}

// Saved per user on the server; this browser keeps a copy and is used when the server can't be reached.
export function usePrefs(onSaveFail: () => void) {
  const [items, setItems] = useState<Item[]>(local);
  useEffect(() => {
    let live = true;
    ui<{ dashboard?: { items: Item[] } }>("/prefs")
      .then((p) => {
        if (!live || !p?.dashboard) return;
        const n = normalise(p.dashboard.items);
        setItems(n);
        try {
          localStorage.setItem(LS, JSON.stringify(n));
        } catch {
          /* ignore */
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  const save = useCallback(
    (next: Item[]) => {
      setItems(next);
      try {
        localStorage.setItem(LS, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      ui("/prefs", { method: "PUT", body: { dashboard: { items: next } } }).catch(onSaveFail);
    },
    [onSaveFail],
  );
  return [items, save] as const;
}
