import { useEffect, useRef, useState } from "react";
import { bytes, incusRaw, ui, type Instance } from "../api";
import { ic } from "../icons";
import { useApp } from "../state";
import { confirmDialog, Dialog, MidTrunc } from "../ui";

type Entry = { name: string; type: string; size: number; mode: string; modified: string; target?: string; uid: number; gid: number };

const join = (dir: string, name: string) => (dir === "/" ? "/" + name : dir + "/" + name);
const isDir = (e: Entry) => e.type === "directory" || e.type === "symlink-dir";

export function FilesTab({ inst }: { inst: Instance & { server: string } }) {
  const app = useApp();
  const [dir, setDir] = useState(inst.type === "virtual-machine" ? "/" : "/root");
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [err, setErr] = useState("");
  const [editPath, setEditPath] = useState(false);
  const [pathInput, setPathInput] = useState(dir);
  const [open, setOpen] = useState<Entry | null>(null);
  const [drag, setDrag] = useState(false);
  const upload = useRef<HTMLInputElement>(null);
  const running = inst.status === "Running";
  const filesURL = (p: string) => `/1.0/instances/${encodeURIComponent(inst.name)}/files?path=${encodeURIComponent(p)}`;
  const o = { project: inst.project };

  const load = (d = dir) => {
    setErr("");
    ui<{ path: string; entries: Entry[] }>(`/files/${encodeURIComponent(inst.server)}/${encodeURIComponent(inst.name)}?project=${encodeURIComponent(inst.project)}&path=${encodeURIComponent(d)}`)
      .then((r) => setEntries(r.entries))
      .catch((e) => {
        setErr(e.message);
        setEntries([]);
      });
  };
  useEffect(() => {
    setEntries(null);
    setPathInput(dir);
    if (running) load(dir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir, running]);

  if (!running)
    return (
      <div className="panel" style={{ padding: 24 }}>
        <b>Start {inst.name} to browse its files.</b>
        <div className="dim">The file explorer works on running instances. Virtual machines also need the Incus agent.</div>
      </div>
    );

  const parts = dir.split("/").filter(Boolean);
  const uploadFiles = async (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      await app.run(
        `Uploading ${f.name}`,
        async () => {
          const r = await incusRaw(inst.server, filesURL(join(dir, f.name)), { ...o, method: "POST", raw: f, headers: { "X-Incus-type": "file", "X-Incus-write": "overwrite", "Content-Type": "application/octet-stream" } });
          if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
        },
        `${f.name} uploaded`,
      );
    }
    load();
  };
  const download = async (e: Entry) => {
    const r = await incusRaw(inst.server, filesURL(join(dir, e.name)), o);
    if (!r.ok) return app.toast(`Can't download ${e.name}`);
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = e.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const remove = async (e: Entry) => {
    const folder = isDir(e) && e.type === "directory";
    if (!(await confirmDialog({ title: `Delete ${e.name}?`, body: folder ? "Only empty folders can be deleted." : `${join(dir, e.name)} is removed from ${inst.name}.`, confirm: "Delete", danger: true }))) return;
    await app.run(`Deleting ${e.name}`, async () => {
      const r = await incusRaw(inst.server, filesURL(join(dir, e.name)), { ...o, method: "DELETE" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    });
    load();
  };
  const mkdir = async () => {
    const n = prompt("Folder name");
    if (!n || n.includes("/")) return;
    await app.run(`Creating ${n}`, async () => {
      const r = await incusRaw(inst.server, filesURL(join(dir, n)), { ...o, method: "POST", headers: { "X-Incus-type": "directory", "X-Incus-mode": "0755" } });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    });
    load();
  };

  return (
    <div
      className="col"
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
      }}
    >
      <div className="toolbar">
        <button className="btn btn-s ib press" aria-label="Up one folder" disabled={dir === "/"} onClick={() => setDir("/" + parts.slice(0, -1).join("/"))}>
          {ic.up}
        </button>
        {editPath ? (
          <form
            className="field"
            style={{ flex: 1, maxWidth: "none" }}
            onSubmit={(e) => {
              e.preventDefault();
              setEditPath(false);
              setDir("/" + pathInput.split("/").filter(Boolean).join("/"));
            }}
          >
            <input className="mono" autoFocus value={pathInput} onChange={(e) => setPathInput(e.target.value)} onBlur={() => setEditPath(false)} />
          </form>
        ) : (
          <div className="pathbar" onDoubleClick={() => setEditPath(true)} title="Double-click to type a path">
            <button onClick={() => setDir("/")}>/</button>
            {parts.map((p, i) => (
              <span key={i}>
                <button onClick={() => setDir("/" + parts.slice(0, i + 1).join("/"))}>{p}</button>
                {i < parts.length - 1 && <span className="dim">/</span>}
              </span>
            ))}
            <button className="pathedit" onClick={() => setEditPath(true)}>
              Edit path
            </button>
          </div>
        )}
        <button className="btn btn-s press" onClick={mkdir}>
          {ic.folder}New folder
        </button>
        <button className="btn btn-p press" onClick={() => upload.current?.click()}>
          {ic.up}Upload
        </button>
        <input ref={upload} type="file" multiple hidden onChange={(e) => e.target.files && uploadFiles(e.target.files)} />
      </div>
      <div className={"panel tw" + (drag ? " dropping" : "")}>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th className="right hide-s">Size</th>
              <th className="hide-m">Permissions</th>
              <th className="hide-m">Owner</th>
              <th className="hide-s">Modified</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {entries === null &&
              Array.from({ length: 6 }).map((_, i) => (
                <tr key={i}>
                  <td colSpan={6}>
                    <span className="sk" style={{ display: "inline-block", width: 160, height: 12 }} />
                  </td>
                </tr>
              ))}
            {entries?.map((e) => (
              <tr key={e.name} onClick={() => (isDir(e) ? setDir(join(dir, e.name)) : setOpen(e))}>
                <td className="fname">
                  <span className="fic">{isDir(e) ? ic.folder : e.type === "symlink" ? ic.link : ic.file}</span>
                  <MidTrunc text={e.name} max={48} />
                  {e.target && <span className="dim mono"> → {e.target}</span>}
                </td>
                <td className="right mono hide-s">{isDir(e) ? "" : bytes(e.size)}</td>
                <td className="mono dim hide-m">{e.mode}</td>
                <td className="mono dim hide-m">
                  {e.uid}:{e.gid}
                </td>
                <td className="dim hide-s">{new Date(e.modified).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</td>
                <td onClick={(ev) => ev.stopPropagation()}>
                  <div className="qa">
                    {!isDir(e) && (
                      <button className="btn btn-q ib btn-sm" aria-label="Download" title="Download" onClick={() => download(e)}>
                        {ic.dl}
                      </button>
                    )}
                    <button className="btn btn-q ib btn-sm" aria-label="Delete" title="Delete" onClick={() => remove(e)}>
                      {ic.trash}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {entries && !entries.length && (
              <tr style={{ cursor: "default" }}>
                <td colSpan={6} className="dim" style={{ padding: 24, textAlign: "center" }}>
                  {err || "This folder is empty. Drop files here to upload."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <Editor inst={inst} path={open ? join(dir, open.name) : ""} entry={open} onClose={() => setOpen(null)} onSaved={() => load()} />
    </div>
  );
}

const MAX_EDIT = 1024 * 1024;

function Editor({ inst, path, entry, onClose, onSaved }: { inst: Instance & { server: string }; path: string; entry: Entry | null; onClose: () => void; onSaved: () => void }) {
  const app = useApp();
  const [text, setText] = useState<string | null>(null);
  const [orig, setOrig] = useState("");
  const [binary, setBinary] = useState(false);
  const url = `/1.0/instances/${encodeURIComponent(inst.name)}/files?path=${encodeURIComponent(path)}`;
  useEffect(() => {
    setText(null);
    setBinary(false);
    if (!entry) return;
    if (entry.size > MAX_EDIT) {
      setBinary(true);
      return;
    }
    incusRaw(inst.server, url, { project: inst.project })
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        const b = new Uint8Array(buf);
        if (b.slice(0, 8000).includes(0)) return setBinary(true);
        const t = new TextDecoder().decode(b);
        setText(t);
        setOrig(t);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry]);
  const save = async () => {
    const ok = await app.run(
      `Saving ${entry?.name}`,
      async () => {
        const r = await incusRaw(inst.server, url, {
          project: inst.project,
          method: "POST",
          raw: text ?? "",
          headers: { "X-Incus-type": "file", "X-Incus-write": "overwrite", "X-Incus-mode": entry!.mode, "X-Incus-uid": String(entry!.uid), "X-Incus-gid": String(entry!.gid), "Content-Type": "application/octet-stream" },
        });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
        return true;
      },
      `${entry?.name} saved`,
    );
    if (ok) {
      onSaved();
      onClose();
    }
  };
  return (
    <Dialog open={!!entry} onClose={onClose} size="md">
      <div className="ptitle">
        <h2 className="mono">{path}</h2>
        <span className="r">{entry && bytes(entry.size)}</span>
      </div>
      {binary ? (
        <div className="dlg-b">
          <p>{entry && entry.size > MAX_EDIT ? "This file is too large to open here. Download it instead." : "This looks like a binary file. Download it instead."}</p>
        </div>
      ) : text === null ? (
        <div className="dlg-b">
          <span className="sk">loading file</span>
        </div>
      ) : (
        <textarea className="yaml" style={{ minHeight: "50vh" }} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
      )}
      <div className="dlg-f">
        <button className="btn btn-s press" onClick={onClose}>
          Close
        </button>
        {!binary && text !== null && (
          <button className="btn btn-p press" disabled={text === orig} onClick={save}>
            Save
          </button>
        )}
      </div>
    </Dialog>
  );
}
