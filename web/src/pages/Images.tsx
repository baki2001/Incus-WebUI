import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { bytes, dateTime, incusOp, incusURL } from "../api";
import { ic } from "../icons";
import { useCrumbs } from "../Shell";
import { invalidate, useApp, useScopedServers } from "../state";
import { useCollection, useCurrentProject } from "../data";
import { confirmDialog, CopyBtn, Field, Input, Seg, Select, Sheet, SheetSec, Table, TglRow } from "../ui";
import { matches, PageHead, Search } from "./Resource";
import { imageName, ociRegistries, RemotePicker, type RemoteImage } from "./ImagePicker";

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
  const [open, setOpen] = useState<Image | null>(null);
  const rows = q.data?.filter((i) => (type === "all" || i.type === type) && matches(search, imageName(i), i.properties?.description, i.fingerprint, i.properties?.os));

  return (
    <>
      <PageHead title="Images">
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
        onRow={setOpen}
        empty={q.error || (search || type !== "all" ? "No images match." : "No images yet. Pull one, or create an instance and Incus keeps its image here.")}
        cols={[
          {
            k: "name",
            label: "Image",
            sort: (i) => i.properties?.description || imageName(i),
            cell: (i) => (
              <span className="nm">
                <span className="nm2">{i.properties?.description || imageName(i)}</span>
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
    const isOci = src === "oci";
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
  const ready = src === "oci" ? !!oci.ref.trim() : !!pick && (!vm || pick.img.vm);

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
      <Seg value={src} onChange={setSrc} label="Source" options={[{ v: "remote", l: "Image server" }, { v: "oci", l: "OCI registry" }]} />
      {src === "remote" ? (
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
    await app.run("Adding name", () => incusOp(i.server, "/1.0/images/aliases", { method: "POST", project, body: { name: alias.trim(), target: i.fingerprint } }), `Named ${alias.trim()}`);
    setAlias("");
    invalidate("images:");
    onClose();
  };
  const delAlias = async (name: string) => {
    if (!i) return;
    await app.run("Removing name", () => incusOp(i.server, `/1.0/images/aliases/${encodeURIComponent(name)}`, { method: "DELETE", project }), `Removed ${name}`);
    invalidate("images:");
    onClose();
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
      title={i ? i.properties?.description || imageName(i) : ""}
      wide
      footer={
        i && (
          <>
            <button className="btn btn-q press l" style={{ color: "var(--err)" }} onClick={del}>
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
                <div key={k} style={{ display: "contents" }}>
                  <dt>{k[0].toUpperCase() + k.slice(1)}</dt>
                  <dd>{v}</dd>
                </div>
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
            <TglRow title="Keep it up to date" note={i.update_source ? "Refreshes from its source every few hours." : "Only for images pulled from a server."} on={i.auto_update} onChange={(o) => patch({ auto_update: o }, o ? "Auto update on" : "Auto update off")} />
            <TglRow title="Public" note="Other Incus servers can pull it from this one without a certificate." on={i.public} onChange={(o) => patch({ public: o }, o ? "Image is public" : "Image is private")} />
          </SheetSec>
        </>
      )}
    </Sheet>
  );
}
