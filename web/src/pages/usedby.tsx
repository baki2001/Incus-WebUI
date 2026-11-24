import { useEffect, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useApp } from "../state";
import { SheetSec } from "../ui";
import "./ws5.css";

type Item = { kind: string; name: string; to?: string; res: string; project: string };

// "/1.0/instances/web?project=dev" -> a label and, where the UI has a page for it, a link.
export function parseUsed(u: string, server: string): Item {
  const [path, qs = ""] = u.split("?");
  const parts = path.split("/").filter(Boolean).slice(1);
  const project = new URLSearchParams(qs).get("project") || "default";
  // Snapshots and backups belong to their instance: /1.0/instances/x/snapshots/s is "x".
  const at = parts[0] === "instances" ? 1 : parts[0] === "storage-pools" && parts[2] === "volumes" ? 4 : parts.length - 1;
  const name = decodeURIComponent(parts[at] || "");
  const proj = project === "default" ? "" : `&project=${encodeURIComponent(project)}`;
  const open = `?open=${encodeURIComponent(name)}${proj}`;
  const res = parts[0] || "";
  const it = (x: Omit<Item, "res" | "project">): Item => ({ ...x, res, project });
  switch (parts[0]) {
    case "instances":
      return it({ kind: "Instance", name, to: `/instances/${encodeURIComponent(server)}/${encodeURIComponent(name)}?project=${encodeURIComponent(project)}` });
    case "profiles":
      return it({ kind: "Profile", name, to: "/profiles" + open });
    case "networks":
      return it({ kind: "Network", name, to: "/networks" + open });
    case "network-acls":
      return it({ kind: "ACL", name, to: "/networks/acls" + open });
    case "projects":
      return it({ kind: "Project", name, to: "/projects" + open });
    case "images":
      return it({ kind: "Image", name: name.slice(0, 12), to: "/images" });
    case "storage-pools":
      return it({ kind: parts[2] === "volumes" ? "Volume" : "Pool", name, to: parts[2] === "volumes" ? "/storage/volumes" : "/storage" });
    default:
      return it({ kind: parts[0] || "Item", name });
  }
}

// The things that use an object, as links. In a dialog the links open in a new
// tab so the dialog stays where it is.
export function UsedByList({
  list,
  server,
  blank,
  max = 8,
  detach,
}: {
  list?: string[];
  server: string;
  blank?: boolean;
  max?: number;
  detach?: (kind: string, name: string, project: string) => void;
}) {
  const [all, setAll] = useState(false);
  const items = (list || []).map((u) => parseUsed(u, server));
  if (!items.length) return <span className="none">Nothing uses it.</span>;
  const shown = all ? items : items.slice(0, max);
  return (
    <span className="ulist">
      {shown.map((it, i) => (
        <span key={i} className="ul-r">
          {it.to ? (
            <Link to={it.to} {...(blank ? { target: "_blank", rel: "noreferrer" } : {})}>
              {it.name}
            </Link>
          ) : (
            <span>{it.name}</span>
          )}
          <small className="dim">
            {it.kind.toLowerCase()}
            {it.project !== "default" && it.res === "instances" ? ` in ${it.project}` : ""}
          </small>
          {detach && (it.res === "instances" || it.res === "profiles") && (
            <button type="button" className="btn btn-q btn-sm press" onClick={() => detach(it.res, it.name, it.project)}>
              Detach
            </button>
          )}
        </span>
      ))}
      {items.length > max && (
        <button type="button" className="btn btn-q btn-sm" onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show all ${items.length}`}
        </button>
      )}
    </span>
  );
}

export function UsedBySec({
  list,
  server,
  title = "Used by",
  detach,
}: {
  list?: string[];
  server: string;
  title?: ReactNode;
  detach?: (kind: string, name: string, project: string) => void;
}) {
  return (
    <SheetSec title={`${title}${list?.length ? ` (${list.length})` : ""}`}>
      <UsedByList list={list} server={server} detach={detach} />
    </SheetSec>
  );
}

// Delete dialog body: what the object is used by, as links.
export function usedByBody(lead: string, list: string[] | undefined, server: string): ReactNode {
  if (!list?.length) return "Nothing uses it.";
  return (
    <>
      {lead}
      <UsedByList list={list} server={server} blank />
    </>
  );
}

// Opens the row named by ?open=name (and switches project from ?project=), as
// used by the links above. Clears the parameters once handled.
export function useOpenParam<T extends { name: string }>(rows: T[] | undefined, openRow: (r: T) => void) {
  const [sp, setSp] = useSearchParams();
  const app = useApp();
  const want = sp.get("open");
  const proj = sp.get("project");
  useEffect(() => {
    if (want && proj && proj !== app.project) app.setProject(proj);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [want, proj]);
  useEffect(() => {
    if (!want || !rows || (proj && proj !== app.project)) return;
    const r = rows.find((x) => x.name === want);
    if (r) openRow(r);
    setSp({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [want, rows, app.project]);
}
