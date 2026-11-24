import { Fragment, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { bytes, dateTime, incusOp, incusURL, upload, waitOp } from "../api";
import { ic } from "../icons";
import { useCrumbs } from "../Shell";
import { invalidate, useApp, useScopedServers } from "../state";
import { useCollection, useCurrentProject } from "../data";
import { confirmDialog, CopyBtn, Field, Input, Seg, Select, Sheet, SheetSec, Table, TglRow } from "../ui";
import { matches, PageHead, Search } from "./Resource";
import { imageName, ociRegistries, RemotePicker, useServerArch, type RemoteImage } from "./ImagePicker";

type Image = {
  fingerprint: string;
  aliases: { name: string; description: string }[];
  properties: Record<string, string>;
  type: string;
  architecture: string;
  size: number;
  uploaded_at: string;
  last_used_at: string;
  cached: boolean;
  auto_update: boolean;
  public: boolean;
  update_source?: { alias: string; server: string; protocol: string };
  server: string;
};

export function Images() {
  useCrumbs([{ label: "Images" }]);
  const app = useApp();
  const nav = useNavigate();
  const project = useCurrentProject();
  const multi = app.servers.length > 1;
  const q = useCollection<Image>("images", "/1.0/images?recursion=1");
  const [search, setSearch] = useState("");
  const [type, setType] = useState<"all" | "container" | "virtual-machine">("all");
  const [pull, setPull] = useState(false);
  const [imp, setImp] = useState(false);
  // Keep only which image is open and look it up on every reload, so the
  // sheet shows the server's answer after a change.
  const [openKey, setOpen] = useState<{ server: string; fingerprint: string } | null>(null);
  const open = (openKey && q.data?.find((i) => i.server === openKey.server && i.fingerprint === openKey.fingerprint)) || null;
  const rows = q.data?.filter((i) => (type === "all" || i.type === type) && matches(search, imageName(i), i.properties?.description, i.fingerprint, i.properties?.os));

  return (
    <>
      <PageHead title="Images">
        <button className="btn btn-s press" onClick={() => setImp(true)}>
          {ic.up}Import from file
        </button>
        <button className="btn btn-p press" onClick={() => setPull(true)}>
          {ic.dl}Pull image
        </button>
      </PageHead>
      <div className="fbar">
        <Search value={search} onChange={setSearch} placeholder="Filter by name, OS, fingerprint" />
        <Seg value={type} onChange={setType} label="Type" options={[{ v: "all", l: "All" }, { v: "container", l: "Containers" }, { v: "virtual-machine", l: "VMs" }]} />
        <span className="dim fnote">Images on the server. New instances start from these without downloading again.</span>
      </div>
      <Table<Image>
        rows={rows}
        loading={q.loading}
        rowKey={(i) => i.server + i.fingerprint}
        onRow={(i) => setOpen({ server: i.server, fingerprint: i.fingerprint })}
        empty={q.error || (search || type !== "all" ? "No images match." : "No images yet. Pull one, or create an instance and Incus keeps its image here.")}
        cols={[
          {
            k: "name",
            label: "Image",
            sort: (i) => i.properties?.description || imageName(i),
            cell: (i) => (
              <span className="nm">
                <span className="nm2">
                  {i.properties?.description || imageName(i)}
                  {i.public && <span className="tag">Public</span>}
                </span>
                <small className="mono dim">{i.aliases?.map((a) => a.name).join(", ") || i.fingerprint.slice(0, 12)}</small>
              </span>
            ),
          },
          { k: "type", label: "Type", sort: (i) => i.type, cell: (i) => <span className="ty">{i.type === "virtual-machine" ? ic.vm : ic.ct}{i.type === "virtual-machine" ? "VM" : "Container"}</span>, cls: "hide-s" },
          { k: "arch", label: "Arch", sort: (i) => i.architecture, cell: (i) => <span className="mono dim">{i.architecture}</span>, cls: "hide-m" },
          { k: "server", label: "Server", sort: (i) => i.server, cell: (i) => i.server, hide: !multi, cls: "hide-m" },
          { k: "src", label: "Kept", sort: (i) => String(i.cached), cell: (i) => <span className="dim">{i.cached ? "Cached, removed when unused" : "Kept"}</span>, cls: "hide-m" },
          { k: "size", label: "Size", sort: (i) => i.size, cell: (i) => <span className="mono">{bytes(i.size)}</span>, cls: "right" },
          { k: "up", label: "Added", sort: (i) => i.uploaded_at, cell: (i) => <span className="dim">{dateTime(i.uploaded_at)}</span>, cls: "hide-s" },
        ]}
      />
      <PullSheet open={pull} onClose={() => setPull(false)} project={project} />
      <ImportSheet open={imp} onClose={() => setImp(false)} project={project} />
      <ImageSheet img={open} onClose={() => setOpen(null)} project={project} onCreate={(i) => nav(`/instances?create=1&image=${i.fingerprint}&server=${i.server}`)} />
    </>
  );
}

// PullSheet copies an image from an image server or OCI registry onto the
// server and keeps it there (not as a cache entry), so it's ready for later.
function PullSheet({ open, onClose, project }: { open: boolean; onClose: () => void; project: string }) {
  const app = useApp();
  const servers = useScopedServers();
  const [server, setServer] = useState("");
  const srv = server || servers[0]?.name || "";
  const [src, setSrc] = useState<"remote" | "oci">("remote");
  const [pick, setPick] = useState<{ alias: string; url: string; img: RemoteImage } | null>(null);
  const [vm, setVm] = useState(false);
  const [oci, setOci] = useState({ url: ociRegistries[0].url, ref: "" });
  const [alias, setAlias] = useState("");
  const [auto, setAuto] = useState(true);

  const go = async () => {
    const isOci = src === "oci" && ociOk;
    const remoteAlias = isOci ? oci.ref.trim() : pick?.alias;
    if (!remoteAlias) return;
    const body: any = {
      source: { type: "image", mode: "pull", server: isOci ? oci.url : pick!.url, protocol: isOci ? "oci" : "simplestreams", alias: remoteAlias, ...(!isOci && vm ? { image_type: "virtual-machine" } : {}) },
      auto_update: auto,
      aliases: alias.trim() ? [{ name: alias.trim() }] : [],
    };
    onClose();
    const ok = await app.run(`Pulling ${remoteAlias}`, (p) => incusOp(srv, "/1.0/images", { method: "POST", project, body }, p).then(() => true), `${remoteAlias} is ready on ${srv}`);
    if (ok) {
      invalidate("images:");
      setPick(null);
      setAlias("");
    }
  };
  const { info } = useServerArch(srv);
  // OCI registries came with Incus 6.3. Until the server answers, assume yes.
  const [maj, min] = String(info?.environment?.server_version || "").split(".").map(Number);
  const ociOk = !info || (info.api_extensions || []).some((e: string) => /oci/.test(e)) || maj > 6 || (maj === 6 && min >= 3);
  const mode = ociOk ? src : "remote";
  const ready = mode === "oci" ? !!oci.ref.trim() : !!pick && (!vm || pick.img.vm);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Pull image"
      wide
      footer={
        <>
          <button className="btn btn-s press" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-p press" disabled={!ready} onClick={go}>
            {ic.dl}Pull
          </button>
        </>
      }
    >
      {ociOk ? (
        <Seg value={src} onChange={setSrc} label="Source" options={[{ v: "remote", l: "Image server" }, { v: "oci", l: "OCI registry" }]} />
      ) : (
        <p className="dim fnote">Pulling from an OCI registry needs Incus 6.3 or newer. {srv} runs {info?.environment?.server_version}.</p>
      )}
      {mode === "remote" ? (
        <>
          <RemotePicker
            server={srv}
            type="any"
            value={pick?.alias || ""}
            onPick={(a, img, url) => {
              setPick({ alias: a, url, img });
              setAlias(a);
              if (!img.container) setVm(true);
              if (!img.vm) setVm(false);
            }}
          />
          {pick && pick.img.container && pick.img.vm && (
            <Field label="Kind">
              <Seg
                value={vm ? "vm" : "ct"}
                onChange={(v) => setVm(v === "vm")}
                options={[
                  ...(pick.img.container ? [{ v: "ct", l: "Container" }] : []),
                  ...(pick.img.vm ? [{ v: "vm", l: "Virtual machine" }] : []),
                ]}
              />
            </Field>
          )}
        </>
      ) : (
        <div className="two">
          <Field label="Registry">
            <Select value={oci.url} onChange={(url) => setOci({ ...oci, url })} options={ociRegistries.map((r) => ({ v: r.url, l: r.name }))} />
          </Field>
          <Field label="Image" hint="Needs Incus 6.3 or newer.">
            <Input autoFocus mono value={oci.ref} onChange={(ref) => (setOci({ ...oci, ref }), setAlias(ref.split("/").pop()!.replace(/:/g, "-")))} placeholder={ociRegistries.find((r) => r.url === oci.url)?.hint} />
          </Field>
        </div>
      )}
      <div className="two">
        <Field label="Local name" hint="Optional. Lets you pick the image by name later.">
          <Input mono value={alias} onChange={setAlias} />
        </Field>
        {servers.length > 1 && (
          <Field label="Server">
            <Select value={srv} onChange={setServer} options={servers.map((s) => s.name)} />
          </Field>
        )}
      </div>
      <TglRow title="Keep it up to date" note="Incus refreshes the image from its source every few hours." on={auto} onChange={setAuto} />
    </Sheet>
  );
}

function ImageSheet({ img, onClose, project, onCreate }: { img: Image | null; onClose: () => void; project: string; onCreate: (i: Image) => void }) {
  const app = useApp();
  const [alias, setAlias] = useState("");
  const i = img;
  const base = i ? `/1.0/images/${i.fingerprint}` : "";
  const patch = async (body: any, msg: string) => {
    if (!i) return;
    await app.run("Saving image", () => incusOp(i.server, base, { method: "PATCH", project, body }), msg);
    invalidate("images:");
  };
  const addAlias = async () => {
    if (!i || !alias.trim()) return;
    const ok = await app.run("Adding name", () => incusOp(i.server, "/1.0/images/aliases", { method: "POST", project, body: { name: alias.trim(), target: i.fingerprint } }).then(() => true), `Named ${alias.trim()}`);
    if (ok) setAlias("");
    invalidate("images:");
  };
  const delAlias = async (name: string) => {
    if (!i) return;
    await app.run("Removing name", () => incusOp(i.server, `/1.0/images/aliases/${encodeURIComponent(name)}`, { method: "DELETE", project }), `Removed ${name}`);
    invalidate("images:");
  };
  const del = async () => {
    if (!i) return;
    const n = imageName(i);
    if (!(await confirmDialog({ title: `Delete image ${n}?`, body: "Instances made from it keep working.", confirm: "Delete", danger: true }))) return;
    const ok = await app.run(`Deleting ${n}`, () => incusOp(i.server, base, { method: "DELETE", project }).then(() => true), `Image ${n} deleted`);
    if (ok) {
      invalidate("images:");
      onClose();
    }
  };
  return (
    <Sheet
      open={!!img}
      onClose={onClose}
      title={i ? `Image ${imageName(i)}` : ""}
      wide
      footer={
        i && (
          <>
            <button className="btn btn-q danger press l" onClick={del}>
              {ic.trash}Delete
            </button>
            <a className="btn btn-s press" style={{ textDecoration: "none" }} href={incusURL(i.server, base + "/export", project)} download>
              {ic.dl}Download
            </a>
            <button className="btn btn-p press" onClick={() => (onClose(), onCreate(i))}>
              {ic.plus}Create instance
            </button>
          </>
        )
      }
    >
      {i && (
        <>
          <dl className="kv tight">
            {i.properties?.description && (
              <>
                <dt>Description</dt>
                <dd>{i.properties.description}</dd>
              </>
            )}
            <dt>Fingerprint</dt>
            <dd className="mono">
              {i.fingerprint.slice(0, 24)}… <CopyBtn text={i.fingerprint} />
            </dd>
            <dt>Type</dt>
            <dd>{i.type === "virtual-machine" ? "Virtual machine" : "Container"}</dd>
            <dt>Architecture</dt>
            <dd>{i.architecture}</dd>
            <dt>Size</dt>
            <dd>{bytes(i.size)}</dd>
            <dt>Added</dt>
            <dd>{dateTime(i.uploaded_at)}</dd>
            <dt>Last used</dt>
            <dd>{dateTime(i.last_used_at)}</dd>
            {i.update_source && (
              <>
                <dt>Source</dt>
                <dd className="mono">
                  {i.update_source.alias} <span className="dim">from {i.update_source.server.replace(/^https:\/\//, "")}</span>
                </dd>
              </>
            )}
            {Object.entries(i.properties || {})
              .filter(([k]) => ["os", "release", "variant", "serial"].includes(k))
              .map(([k, v]) => (
                <Fragment key={k}>
                  <dt>{k === "os" ? "OS" : k[0].toUpperCase() + k.slice(1)}</dt>
                  <dd>{v}</dd>
                </Fragment>
              ))}
          </dl>
          <SheetSec title="Names">
            <div className="dl">
              {(i.aliases || []).map((a) => (
                <div className="drow d3" key={a.name}>
                  <span className="mono">{a.name}</span>
                  <span />
                  <button className="btn btn-q ib btn-sm" aria-label={"Remove " + a.name} onClick={() => delAlias(a.name)}>
                    {ic.x}
                  </button>
                </div>
              ))}
            </div>
            <div className="kvr" style={{ gridTemplateColumns: "minmax(0,1fr) auto" }}>
              <Input mono value={alias} onChange={setAlias} placeholder="Add a name" onKeyDown={(e) => e.key === "Enter" && addAlias()} />
              <button className="btn btn-s btn-sm press" disabled={!alias.trim()} onClick={addAlias}>
                Add
              </button>
            </div>
          </SheetSec>
          <SheetSec title="Options">
            {i.update_source && <TglRow title="Keep it up to date" note="Refreshes from its source every few hours." on={i.auto_update} onChange={(o) => patch({ auto_update: o }, o ? "Auto update on" : "Auto update off")} />}
            <TglRow title="Public" note="Other Incus servers can pull it from this one without a certificate." on={i.public}
              onChange={async (o) => {
                if (o && !(await confirmDialog({ title: "Make this image public?", body: "Anyone who can reach this server can download this image.", confirm: "Make public" }))) return;
                patch({ public: o }, o ? "Image is public" : "Image is private");
              }} />
          </SheetSec>
        </>
      )}
    </Sheet>
  );
}

// ImportSheet uploads an image from a file: one unified tarball, or the
// metadata file plus a separate root filesystem.
function ImportSheet({ open, onClose, project }: { open: boolean; onClose: () => void; project: string }) {
  const app = useApp();
  const servers = useScopedServers();
  const [server, setServer] = useState("");
  const srv = server || servers[0]?.name || "";
  const [file, setFile] = useState<File | null>(null);
  const [root, setRoot] = useState<File | null>(null);
  const [alias, setAlias] = useState("");
  const [pub, setPub] = useState(false);
  const [frac, setFrac] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const rinput = useRef<HTMLInputElement>(null);
  const pick = (f: File | undefined) => {
    if (!f) return;
    setFile(f);
    setAlias((a) => a || f.name.replace(/\.(tar(\.(gz|xz|bz2|zst))?|tgz|squashfs|qcow2|img)$/i, "").replace(/[^a-zA-Z0-9_./-]/g, "-"));
  };
  const go = async () => {
    if (!file) return;
    const name = alias.trim();
    setFrac(0);
    const ok = await app.run(
      `Importing ${file.name}`,
      async (progress) => {
        const headers: Record<string, string> = { "X-Incus-public": String(pub) };
        let body: Blob | FormData = file;
        if (root) {
          // Split image: the browser sets the multipart type and boundary.
          const fd = new FormData();
          fd.append("metadata", file, file.name);
          fd.append(/\.(qcow2|img)$/i.test(root.name) ? "rootfs.img" : "rootfs", root, root.name);
          body = fd;
        } else headers["Content-Type"] = "application/octet-stream";
        const d = await upload(incusURL(srv, "/1.0/images", project), body as Blob, headers, (f) => {
          setFrac(f);
          progress(`${Math.round(f * 100)}%`);
        });
        let fp = d?.metadata?.fingerprint;
        if (d?.type === "async") fp = (await waitOp(srv, d.metadata.id, project)).metadata?.fingerprint;
        if (name && fp) await incusOp(srv, "/1.0/images/aliases", { method: "POST", project, body: { name, target: fp } });
        return true;
      },
      "Image imported",
    );
    setFrac(null);
    if (ok) {
      invalidate("images:");
      setFile(null);
      setRoot(null);
      setAlias("");
      onClose();
    }
  };
  const drop = (set: (f: File | undefined) => void) => ({
    onDragOver: (e: React.DragEvent) => e.preventDefault(),
    onDrop: (e: React.DragEvent) => (e.preventDefault(), set(e.dataTransfer.files[0])),
  });
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Import image"
      footer={
        <>
          <button className="btn btn-s press" onClick={onClose}>
            {frac !== null ? "Hide" : "Cancel"}
          </button>
          <button className="btn btn-p press" disabled={!file || frac !== null} onClick={go}>
            {ic.up}Import
          </button>
        </>
      }
    >
      <div className="drop" onClick={() => input.current?.click()} {...drop(pick)}>
        {ic.up}
        <b>{file ? file.name : "Drop an image file here or click to choose"}</b>
        <span className="dim">{file ? bytes(file.size) : "A single image tarball, or the metadata file of a split image."}</span>
        <input ref={input} type="file" hidden onChange={(e) => pick(e.target.files?.[0])} />
      </div>
      <div className="drop slim" onClick={() => rinput.current?.click()} {...drop((f) => setRoot(f || null))}>
        <b>{root ? root.name : "Root filesystem file"}</b>
        <span className="dim">{root ? bytes(root.size) : "Only for split images. Leave empty for a single tarball."}</span>
        <input ref={rinput} type="file" hidden onChange={(e) => setRoot(e.target.files?.[0] || null)} />
      </div>
      {frac !== null && (
        <div className="prog">
          <i style={{ transform: `scaleX(${frac})` }} />
        </div>
      )}
      <div className="two">
        <Field label="Name" hint="Optional. Lets you pick the image by name later.">
          <Input mono value={alias} onChange={setAlias} />
        </Field>
        {servers.length > 1 && (
          <Field label="Server">
            <Select value={srv} onChange={setServer} options={servers.map((s) => s.name)} />
          </Field>
        )}
      </div>
      <TglRow title="Public" note="Other Incus servers can pull it from this one without a certificate." on={pub} onChange={setPub} />
    </Sheet>
  );
}
