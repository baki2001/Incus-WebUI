import { useState, type ReactNode } from "react";
import YAML from "yaml";
import { bytes, dateTime, incus, incusOp } from "../api";
import { ic } from "../icons";
import { useCrumbs } from "../Shell";
import { invalidate, useApp, useData, useScopedServers } from "../state";
import { confirmDialog, Dialog, SkRows } from "../ui";
import { diffLines } from "./Config";

// Generic list for one Incus collection across the servers in scope.
function useCollection<T>(name: string, path: string) {
  const { project } = useApp();
  const servers = useScopedServers();
  const names = servers.map((s) => s.name).join(",");
  const p = project === "*" ? "default" : project;
  return useData<(T & { server: string })[]>(names ? `${name}:${names}:${p}` : null, async () => {
    const all = await Promise.all(servers.map(async (s) => (await incus<T[]>(s.name, path, { project: p }).catch(() => [] as T[])).map((x) => ({ ...x, server: s.name }))));
    return all.flat();
  });
}

function Page({ title, cols, children, loading, empty, actions }: { title: string; cols: string[]; children: ReactNode; loading: boolean; empty: boolean; actions?: ReactNode }) {
  useCrumbs([{ label: title }]);
  const multi = useApp().servers.length > 1;
  return (
    <>
      <div className="ph">
        <h1>{title}</h1>
        <div className="r">{actions}</div>
      </div>
      <div className="panel tw">
        <table>
          <thead>
            <tr>
              {cols.filter((c) => multi || c !== "Server").map((c, i) => (
                <th key={i} className={c.endsWith(" ") ? "right" : ""}>
                  {c.trim()}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && <SkRows cols={cols.length} rows={4} />}
            {children}
            {empty && (
              <tr style={{ cursor: "default" }}>
                <td colSpan={cols.length} className="dim" style={{ padding: 24, textAlign: "center" }}>
                  Nothing here yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function Images() {
  const app = useApp();
  const multi = app.servers.length > 1;
  const q = useCollection<any>("images", "/1.0/images?recursion=1");
  const del = async (i: any) => {
    const n = i.aliases?.[0]?.name || i.fingerprint.slice(0, 12);
    if (!(await confirmDialog({ title: `Delete image ${n}?`, body: "Instances made from it keep working.", confirm: "Delete", danger: true }))) return;
    await app.run(`Deleting ${n}`, () => incusOp(i.server, `/1.0/images/${i.fingerprint}`, { method: "DELETE", project: app.project === "*" ? "default" : app.project }), `Image ${n} deleted`);
    invalidate("images:");
  };
  return (
    <Page title="Images" cols={["Alias", "Description", "Type", "Server", "Size ", "Uploaded", ""]} loading={!q.data && q.loading} empty={!!q.data && !q.data.length}>
      {q.data?.map((i) => (
        <tr key={i.server + i.fingerprint} style={{ cursor: "default" }}>
          <td className="nm">
            <b className="mono">{i.aliases?.map((a: any) => a.name).join(", ") || i.fingerprint.slice(0, 12)}</b>
            <small className="mono">{i.fingerprint.slice(0, 12)}</small>
          </td>
          <td>{i.properties?.description || "–"}</td>
          <td>{i.type === "virtual-machine" ? "VM" : "Container"}</td>
          {multi && <td>{i.server}</td>}
          <td className="right mono">{bytes(i.size)}</td>
          <td className="dim">{dateTime(i.uploaded_at)}</td>
          <td>
            <div className="qa" style={{ opacity: 1 }}>
              <button className="btn btn-q ib btn-sm" aria-label="Delete" onClick={() => del(i)}>
                {ic.trash}
              </button>
            </div>
          </td>
        </tr>
      ))}
    </Page>
  );
}

export function Storage() {
  const multi = useApp().servers.length > 1;
  const q = useCollection<any>("pools", "/1.0/storage-pools?recursion=1");
  return (
    <Page title="Storage" cols={["Pool", "Driver", "Server", "Status", "Used by ", "Source"]} loading={!q.data && q.loading} empty={!!q.data && !q.data.length}>
      {q.data?.map((p) => (
        <tr key={p.server + p.name} style={{ cursor: "default" }}>
          <td className="nm">
            <b>{p.name}</b>
            {p.description && <small>{p.description}</small>}
          </td>
          <td className="mono">{p.driver}</td>
          {multi && <td>{p.server}</td>}
          <td>
            <span className={"st " + (p.status === "Created" ? "running" : "error")}>{p.status}</span>
          </td>
          <td className="right mono">{p.used_by?.length ?? 0}</td>
          <td className="mono dim">{p.config?.source || "–"}</td>
        </tr>
      ))}
    </Page>
  );
}

export function Networks() {
  const multi = useApp().servers.length > 1;
  const q = useCollection<any>("networks", "/1.0/networks?recursion=1");
  return (
    <Page title="Networks" cols={["Name", "Type", "Server", "IPv4", "IPv6", "Used by "]} loading={!q.data && q.loading} empty={!!q.data && !q.data.length}>
      {q.data
        ?.filter((n) => n.managed)
        .map((n) => (
          <tr key={n.server + n.name} style={{ cursor: "default" }}>
            <td className="nm">
              <b>{n.name}</b>
              {n.description && <small>{n.description}</small>}
            </td>
            <td>{n.type}</td>
            {multi && <td>{n.server}</td>}
            <td className="mono">{n.config?.["ipv4.address"] || "–"}</td>
            <td className="mono dim">{n.config?.["ipv6.address"] || "–"}</td>
            <td className="right mono">{n.used_by?.length ?? 0}</td>
          </tr>
        ))}
    </Page>
  );
}

export function Profiles() {
  const app = useApp();
  const multi = app.servers.length > 1;
  const q = useCollection<any>("profiles", "/1.0/profiles?recursion=1");
  const [edit, setEdit] = useState<any>(null);
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const [review, setReview] = useState(false);
  const project = app.project === "*" ? "default" : app.project;
  const orig = edit ? YAML.stringify({ description: edit.description, config: edit.config, devices: edit.devices }) : "";
  const save = async () => {
    let body: any;
    try {
      body = YAML.parse(text);
    } catch (e: any) {
      setErr(e.message);
      return;
    }
    setReview(false);
    const ok = await app.run(`Saving profile ${edit.name}`, async () => (await incusOp(edit.server, `/1.0/profiles/${encodeURIComponent(edit.name)}`, { method: "PUT", project, body }), true), `Profile ${edit.name} saved`);
    if (ok) {
      setEdit(null);
      invalidate("profiles:");
    }
  };
  return (
    <>
      <Page title="Profiles" cols={["Name", "Description", "Server", "Devices", "Used by "]} loading={!q.data && q.loading} empty={!!q.data && !q.data.length}>
        {q.data?.map((p) => (
          <tr
            key={p.server + p.name}
            onClick={() => {
              setEdit(p);
              setErr("");
              setText(YAML.stringify({ description: p.description, config: p.config, devices: p.devices }));
            }}
          >
            <td>
              <b style={{ fontWeight: 500 }}>{p.name}</b>
            </td>
            <td className="dim">{p.description || "–"}</td>
            {multi && <td>{p.server}</td>}
            <td className="mono dim">{Object.keys(p.devices || {}).join(", ") || "–"}</td>
            <td className="right mono">{p.used_by?.length ?? 0}</td>
          </tr>
        ))}
      </Page>
      <Dialog open={!!edit && !review} onClose={() => setEdit(null)} size="md">
        <div className="ptitle">
          <h2>Profile {edit?.name}</h2>
          <span className="r">Changes apply to every instance that uses it</span>
        </div>
        <textarea className="yaml" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} style={{ minHeight: "45vh" }} />
        {err && <div className="pfoot bad">{err}</div>}
        <div className="dlg-f">
          <button className="btn btn-s press" onClick={() => setEdit(null)}>
            Cancel
          </button>
          <button className="btn btn-p press" disabled={text === orig} onClick={() => setReview(true)}>
            Review
          </button>
        </div>
      </Dialog>
      <Dialog open={review} onClose={() => setReview(false)} size="md">
        <div className="dlg-b">
          <h2>Review changes to {edit?.name}</h2>
          <div className="diff">
            {diffLines(orig, text).map((l, i) => (
              <div key={i} className={l.t}>
                {l.t === "c" ? "  " + l.s : l.s}
              </div>
            ))}
          </div>
        </div>
        <div className="dlg-f">
          <button className="btn btn-s press" onClick={() => setReview(false)}>
            Keep editing
          </button>
          <button className="btn btn-p press" onClick={save}>
            Apply
          </button>
        </div>
      </Dialog>
    </>
  );
}
