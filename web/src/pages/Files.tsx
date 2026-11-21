import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { bytes, friendlyError, incusRaw, ui, type Instance } from "../api";
import { ic } from "../icons";
import { useApp } from "../state";
import { confirmDialog, Dialog, MidTrunc } from "../ui";

type Entry = { name: string; type: string; size: number; mode: string; modified: string; target?: string; resolved?: string; uid: number; gid: number };

const join = (dir: string, name: string) => (dir === "/" ? "/" + name : dir + "/" + name);
const isDir = (e: Entry) => e.type === "directory" || e.type === "symlink-dir";
const isLink = (e: Entry) => e.type === "symlink" || e.type === "symlink-dir";
// A link is read and written through its target, never as the link itself.
const filePath = (dir: string, e: Entry) => e.resolved || join(dir, e.name);
const errMsg = async (r: Response) => (await r.json().catch(() => ({}))).error || r.statusText;
// "a.txt" -> "a (1).txt" until the name is free
const freeName = (name: string, taken: Set<string>) => {
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let i = 1; ; i++) if (!taken.has(`${stem} (${i})${ext}`)) return `${stem} (${i})${ext}`;
};
// Turns raw SFTP / Incus errors into something a person can act on.
function readable(msg: string, p: string) {
  if (/not a directory/i.test(msg)) return `${p} is a file, not a folder.`;
  if (/no such file|not exist|not found/i.test(msg)) return `${p} doesn't exist.`;
  if (/permission denied/i.test(msg)) return `Permission denied for ${p}.`;
  if (/not empty/i.test(msg)) return "The folder is not empty.";
  return friendlyError(new Error(msg));
}

type Choice = "replace" | "both" | "cancel";

export function FilesTab({ inst }: { inst: Instance & { server: string } }) {
  const app = useApp();
  // The folder lives in the URL (?path=) so it can be linked, and Back goes up.
  const [params, setParams] = useSearchParams();
  const dir = params.get("path") || (inst.type === "virtual-machine" ? "/" : "/root");
  const setDir = (d: string) =>
    setParams((p) => {
      const n = new URLSearchParams(p);
      n.set("path", d);
      return n;
    });
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [err, setErr] = useState("");
  const [editPath, setEditPath] = useState(false);
  const [pathInput, setPathInput] = useState(dir);
  const [open, setOpen] = useState<Entry | null>(null);
  const [newFolder, setNewFolder] = useState(false);
  const [clash, setClash] = useState<{ name: string; res: (v: Choice) => void } | null>(null);
  const [drag, setDrag] = useState(false);
  const upload = useRef<HTMLInputElement>(null);
  const running = inst.status === "Running";
  const filesURL = (p: string) => `/1.0/instances/${encodeURIComponent(inst.name)}/files?path=${encodeURIComponent(p)}`;
  const o = { project: inst.project };
  const apiBase = `/files/${encodeURIComponent(inst.server)}/${encodeURIComponent(inst.name)}`;
  const q = (p: string) => `?project=${encodeURIComponent(inst.project)}&path=${encodeURIComponent(p)}`;
  const list = (d: string) => ui<{ path: string; entries: Entry[] }>(apiBase + q(d));

  const load = (d = dir) => {
    setErr("");
    list(d)
      .then((r) => setEntries(r.entries))
      .catch((e) => {
        setErr(readable(e.message, d));
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
    const taken = new Set((entries || []).map((e) => e.name));
    for (const f of Array.from(files)) {
      let name = f.name;
      if (taken.has(name)) {
        const choice = await new Promise<Choice>((res) => setClash({ name, res }));
        setClash(null);
        if (choice === "cancel") continue;
        if (choice === "both") name = freeName(name, taken);
      }
      taken.add(name);
      await app.run(
        `Uploading ${name}`,
        async () => {
          const r = await incusRaw(inst.server, filesURL(join(dir, name)), { ...o, method: "POST", raw: f, headers: { "X-Incus-type": "file", "X-Incus-write": "overwrite", "Content-Type": "application/octet-stream" } });
          if (!r.ok) throw new Error(await errMsg(r));
        },
        `${name} uploaded`,
      );
    }
    load();
  };
  const download = async (e: Entry) => {
    // Check the response headers first, so an error shows as a toast instead of replacing the page.
    const href = `/api/ui${apiBase}/download${q(join(dir, e.name))}`; // the server follows links
    const ac = new AbortController();
    try {
      const r = await fetch(href, { headers: { "X-Incus-UI": "1" }, signal: ac.signal });
      if (!r.ok) throw new Error(await errMsg(r));
      ac.abort(); // headers are enough; the browser downloads the file itself
    } catch (err) {
      return app.fail(readable(err instanceof Error ? err.message : String(err), join(dir, e.name)), `Can't download ${e.name}.`);
    }
    // The server sends a proper Content-Disposition, non-ASCII names too.
    const a = document.createElement("a");
    a.href = href;
    a.download = e.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  const remove = async (e: Entry) => {
    const folder = e.type === "directory";
    const p = join(dir, e.name);
    if (!(await confirmDialog({ title: `Delete ${e.name}?`, body: `${p} is removed from ${inst.name}.`, confirm: "Delete", danger: true }))) return;
    const r = await incusRaw(inst.server, filesURL(p), { ...o, method: "DELETE" }).catch(() => null);
    if (r?.ok) {
      app.toast(`${e.name} deleted`);
      return load();
    }
    const msg = r ? await errMsg(r) : "The request failed.";
    if (folder && /not empty|directory/i.test(msg) && !/permission|no such/i.test(msg)) {
      if (await confirmDialog({ title: `${e.name} is not empty`, body: "Delete the folder and everything inside it? This can't be undone.", confirm: "Delete everything", danger: true })) {
        await app.run(`Deleting ${e.name}`, () => ui(apiBase + q(p), { method: "DELETE" }), `${e.name} deleted`);
      }
    } else app.fail(readable(msg, p), `Can't delete ${e.name}.`);
    load();
  };
  const mkdir = async (n: string) => {
    const ok = await app.run(`Creating ${n}`, async () => {
      const r = await incusRaw(inst.server, filesURL(join(dir, n)), { ...o, method: "POST", headers: { "X-Incus-type": "directory", "X-Incus-mode": "0755" } });
      if (!r.ok) throw new Error(await errMsg(r));
      return true;
    });
    if (ok) setNewFolder(false);
    load();
  };
  // "Edit path": a folder opens, a file opens in the editor, anything else says why not.
  const goPath = async (raw: string) => {
    const p = "/" + raw.split("/").filter(Boolean).join("/");
    try {
      await list(p);
      return setDir(p);
    } catch (e: any) {
      const parent = "/" + p.split("/").filter(Boolean).slice(0, -1).join("/");
      const base = p.split("/").pop()!;
      try {
        const hit = (await list(parent)).entries.find((x) => x.name === base);
        if (hit && !isDir(hit)) {
          setDir(parent);
          return setOpen(hit);
        }
      } catch {
        /* fall through to the message */
      }
      app.fail(readable(e.message, p), `Can't open ${p}.`);
    }
  };
  const openEntry = (e: Entry) => {
    if (isDir(e)) return setDir(join(dir, e.name));
    if (isLink(e) && !e.resolved) return app.toast(`${e.name} is a broken link${e.target ? ` to ${e.target}` : ""}.`);
    setOpen(e);
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
              goPath(pathInput);
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
        <button className="btn btn-s press" onClick={() => setNewFolder(true)}>
          {ic.folder}New folder
        </button>
        <button className="btn btn-p press" onClick={() => upload.current?.click()}>
          {ic.up}Upload
        </button>
        <input
          ref={upload}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) uploadFiles(e.target.files);
            e.target.value = "";
          }}
        />
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
              <tr key={e.name} onClick={() => openEntry(e)}>
                <td>
                  <div className="fname">
                  <span className="fic">{isLink(e) ? ic.link : isDir(e) ? ic.folder : ic.file}</span>
                  <MidTrunc text={e.name} max={48} />
                  {e.target && (
                    <span className="dim mono" title={e.resolved ? `Link to ${e.target}` : "Broken link"}>
                      {" "}
                      → {e.target}
                      {!e.resolved && " (broken)"}
                    </span>
                  )}
                  </div>
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
      <NewFolder open={newFolder} existing={entries || []} onClose={() => setNewFolder(false)} onCreate={mkdir} />
      <Dialog open={!!clash} onClose={() => clash?.res("cancel")} size="sm">
        <div className="dlg-b">
          <h2>{clash?.name} already exists</h2>
          <p>Replace it with the file you are uploading, or keep both and give the new file another name.</p>
        </div>
        <div className="dlg-f">
          <button className="btn btn-s press" onClick={() => clash?.res("cancel")}>
            Cancel
          </button>
          <button className="btn btn-s press" onClick={() => clash?.res("both")}>
            Keep both
          </button>
          <button className="btn btn-p press" onClick={() => clash?.res("replace")}>
            Replace
          </button>
        </div>
      </Dialog>
      <Editor inst={inst} path={open ? filePath(dir, open) : ""} entry={open} onClose={() => setOpen(null)} onSaved={() => load()} />
    </div>
  );
}

function NewFolder({ open, existing, onClose, onCreate }: { open: boolean; existing: Entry[]; onClose: () => void; onCreate: (n: string) => void }) {
  const [name, setName] = useState("");
  useEffect(() => {
    if (open) setName("");
  }, [open]);
  const n = name.trim();
  const bad = n.includes("/") ? "A folder name can't contain /." : n === "." || n === ".." ? "Choose another name." : existing.some((e) => e.name === n) ? `${n} already exists here.` : "";
  return (
    <Dialog open={open} onClose={onClose} size="sm">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (n && !bad) onCreate(n);
        }}
      >
        <div className="dlg-b">
          <h2>New folder</h2>
          <div className="fl" style={{ marginTop: 10 }}>
            <label>Name</label>
            <div className={"field" + (bad ? " bad" : "")}>
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className={"hint" + (bad ? " bad" : "")}>{bad}</div>
          </div>
        </div>
        <div className="dlg-f">
          <button type="button" className="btn btn-s press" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-p press" disabled={!n || !!bad}>
            Create
          </button>
        </div>
      </form>
    </Dialog>
  );
}

const MAX_EDIT = 1024 * 1024;

function Editor({ inst, path, entry, onClose, onSaved }: { inst: Instance & { server: string }; path: string; entry: Entry | null; onClose: () => void; onSaved: () => void }) {
  const app = useApp();
  const [text, setText] = useState<string | null>(null);
  const [orig, setOrig] = useState("");
  const [binary, setBinary] = useState(false);
  const dirty = text !== null && text !== orig;
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
      .then(async (r) => {
        if (!r.ok) throw new Error(await errMsg(r));
        return r.arrayBuffer();
      })
      .then((buf) => {
        const b = new Uint8Array(buf);
        if (b.slice(0, 8000).includes(0)) return setBinary(true);
        const t = new TextDecoder().decode(b);
        setText(t);
        setOrig(t);
      })
      .catch((e) => {
        app.fail(e, `Can't open ${entry.name}.`);
        onClose();
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
        if (!r.ok) throw new Error(await errMsg(r));
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
    <Dialog open={!!entry} onClose={onClose} dirty={dirty} size="md">
      <div className="ptitle">
        <h2 className="mono">{path}</h2>
        <span className="r">{entry && bytes(entry.size)}</span>
      </div>
      {entry && isLink(entry) && (
        <div className="dlg-b" style={{ paddingBottom: 0 }}>
          <p className="dim">
            {entry.name} is a link. You are editing the file it points to.
          </p>
        </div>
      )}
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
          <button className="btn btn-p press" disabled={!dirty} onClick={save}>
            Save
          </button>
        )}
      </div>
    </Dialog>
  );
}
