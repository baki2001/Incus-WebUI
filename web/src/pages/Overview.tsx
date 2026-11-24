import { useCallback, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { ic } from "../icons";
import { useCrumbs } from "../Shell";
import { useApp, useScopedServers } from "../state";
import { useCurrentProject, useInstances } from "../data";
import { Capacity } from "./overview/Capacity";
import { Customize } from "./overview/Customize";
import { Boot, BaseImages, Pinned, usePinned } from "./overview/Lists";
import { useCap, useImages, useInfo, useNets, useTunnels } from "./overview/model";
import { Addresses, Exposure, Ports, Tunnels } from "./overview/Network";
import { type D } from "./overview/parts";
import { usePrefs, type Item } from "./overview/prefs";
import { Snapshots, Timeline } from "./overview/Snapshots";
import "./overview.css";

// Columns (of 12) each element wants; a row is filled by stretching its elements.
const SPAN: Record<string, [number, number]> = {
  capacity: [8, 8],
  snapshots: [3, 4],
  timeline: [12, 12],
  addresses: [3, 4],
  tunnels: [3, 5],
  exposure: [3, 3],
  ports: [3, 3],
  boot: [6, 6],
  pinned: [3, 3],
  images: [5, 5],
};

type Cell = { id: string; span: number; node: ReactNode; cls: string };

function pack(cells: Omit<Cell, "span">[], want: (id: string) => number): Cell[][] {
  const rows: { c: Omit<Cell, "span">; w: number }[][] = [[]];
  let sum = 0;
  for (const c of cells) {
    const w = want(c.id);
    if (sum + w > 12) {
      rows.push([]);
      sum = 0;
    }
    rows[rows.length - 1].push({ c, w });
    sum += w;
  }
  return rows
    .filter((r) => r.length)
    .map((r) => {
      const extra = 12 - r.reduce((a, b) => a + b.w, 0);
      return r.map((x, i) => ({ ...x.c, span: x.w + Math.floor(extra / r.length) + (i < extra % r.length ? 1 : 0) }));
    });
}

export function Overview() {
  useCrumbs([{ label: "Overview" }]);
  const app = useApp();
  const nav = useNavigate();
  const project = useCurrentProject();
  const scoped = useScopedServers();
  const servers = app.scope === "*" ? app.servers : app.servers.filter((s) => s.name === app.scope);
  const [open, setOpen] = useState(false);
  const failed = useCallback(() => app.toast("Saved in this browser only. The server couldn't store your layout."), [app]); // eslint-disable-line react-hooks/exhaustive-deps
  const [items, save] = usePrefs(failed);
  const on = (id: string) => items.some((i) => i.id === id && i.on);

  const inst = useInstances(10000);
  const info = useInfo(scoped, on("capacity") || on("exposure") || on("timeline"));
  const cap = useCap(scoped, on("capacity"));
  const nets = useNets(scoped, project, on("addresses") || on("ports") || on("exposure"));
  const images = useImages(scoped, project, on("timeline") || on("images"));
  const tunnels = useTunnels(on("tunnels"));
  const d: D = { rows: inst.data, rowsKey: inst.key, servers, info: info.data, cap: cap.data, nets: nets.data, images: images.data, tunnels: tunnels.data };
  const pinned = usePinned(inst.data);

  const size = (it: Item) => (it.size === "s" ? 0 : 1);
  const cells: Omit<Cell, "span">[] = [];
  for (const it of items) {
    if (!it.on) continue;
    let node: ReactNode = null;
    switch (it.id) {
      case "capacity":
        node = <Capacity d={d} />;
        break;
      case "snapshots":
        node = <Snapshots d={d} size={it.size === "s" ? "s" : "m"} />;
        break;
      case "timeline":
        node = <Timeline d={d} />;
        break;
      case "addresses":
        node = <Addresses d={d} size={it.size === "s" ? "s" : "m"} />;
        break;
      case "tunnels":
        if (tunnels.data) node = <Tunnels d={d} size={it.size === "s" ? "s" : "m"} />;
        break;
      case "exposure":
        node = <Exposure d={d} />;
        break;
      case "ports":
        node = <Ports d={d} />;
        break;
      case "boot":
        node = <Boot d={d} />;
        break;
      case "pinned":
        if (pinned.length) node = <Pinned d={d} rows={pinned} />;
        break;
      case "images":
        node = <BaseImages d={d} />;
        break;
    }
    if (node) cells.push({ id: it.id, node, cls: it.id + (it.size ? " " + it.size : "") });
  }
  const rows = pack(cells, (id) => SPAN[id][size(items.find((i) => i.id === id)!)]);

  return (
    <>
      <div className="ph">
        <h1>Overview</h1>
        <div className="r">
          <button className="btn btn-s press" onClick={() => setOpen(true)}>
            Customize
          </button>
          <button className="btn btn-p press" onClick={() => nav("/instances?create=1")}>
            {ic.plus}Create instance
          </button>
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="bento">
          <div className="b-row">
            <div className="b-cell" style={{ ["--sp" as any]: 12 }}>
              <p className="none">Nothing to show. Use Customize to add elements.</p>
            </div>
          </div>
        </div>
      ) : (
        <div className="bento">
          {rows.map((r, i) => (
            <div className="b-row" key={i}>
              {r.map((c) => (
                <section className={"b-cell b-" + c.cls} key={c.id} style={{ ["--sp" as any]: c.span }}>
                  {c.node}
                </section>
              ))}
            </div>
          ))}
        </div>
      )}
      <Customize open={open} onClose={() => setOpen(false)} items={items} onChange={save} />
    </>
  );
}
