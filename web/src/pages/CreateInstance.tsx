import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { incus, incusOp } from "../api";
import { ic } from "../icons";
import { invalidate, useApp, useData, useScopedServers } from "../state";
import { listVolumes, useCurrentProject, useNames } from "../data";
import { Field, Input, KVEditor, Seg, Select, Sheet, SheetSec, shake, TglRow } from "../ui";
import { LocalPicker, ociRegistries, RemotePicker, useServerArch } from "./ImagePicker";

const nameRe = /^[a-zA-Z][a-zA-Z0-9-]{0,62}$/;
type Source = "remote" | "local" | "oci" | "iso" | "none";

export type CreatePreset = { image?: string; server?: string; iso?: string };

export function CreateInstance({ open, onClose, preset }: { open: boolean; onClose: () => void; preset?: CreatePreset }) {
  const app = useApp();
  const nav = useNavigate();
  const servers = useScopedServers();
  const project = useCurrentProject();
  const [server, setServer] = useState("");
  const srv = server || servers[0]?.name || "";
  const { vm: vmOK } = useServerArch(open ? srv : "");

  const [name, setName] = useState("");
  const [type, setType] = useState<"container" | "virtual-machine">("container");
  const [source, setSource] = useState<Source>("remote");
  const [alias, setAlias] = useState("");
  const [remoteURL, setRemoteURL] = useState("");
  const [variant, setVariant] = useState("");
  const [fp, setFp] = useState("");
  const [oci, setOci] = useState({ url: ociRegistries[0].url, ref: "" });
  const [iso, setIso] = useState("");
  const [profiles, setProfiles] = useState<string[]>(["default"]);
  const [cpu, setCpu] = useState("");
  const [mem, setMem] = useState("");
  const [disk, setDisk] = useState("");
  const [pool, setPool] = useState("");
  const [network, setNetwork] = useState("");
  const [cloudInit, setCloudInit] = useState("");
  const [desc, setDesc] = useState("");
  const [start, setStart] = useState(true);
  const [autostart, setAutostart] = useState(false);
  const [nesting, setNesting] = useState(false);
  const [ephemeral, setEphemeral] = useState(false);
  const [secureboot, setSecureboot] = useState(true);
  const [extra, setExtra] = useState<Record<string, string>>({});
  const [tried, setTried] = useState(false);
  const body = useRef<HTMLDivElement>(null);

  const local = useData<any[]>(open && srv ? `images:${srv}:${project}` : null, () => incus(srv, "/1.0/images?recursion=1", { project }));
  const profs = useNames(open ? srv : "", "profiles", project);
  const pools = useNames(open ? srv : "", "storage-pools", project);
  const nets = useNames(open ? srv : "", "networks", project);
  const isos = useData<any[]>(open && srv && type === "virtual-machine" ? `isos:${srv}:${project}` : null, async () =>
    (await listVolumes(srv, project)).filter((v) => v.content_type === "iso"),
  );

  useEffect(() => {
    if (open) {
      setName("");
      setTried(false);
      if (preset?.server) setServer(preset.server);
      if (preset?.image) {
        setSource("local");
        setFp(preset.image);
      }
      if (preset?.iso) {
        setType("virtual-machine");
        setSource("iso");
        setIso(preset.iso);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  // An image picked from the Images page decides the type.
  useEffect(() => {
    const img = local.data?.find((i) => i.fingerprint === fp);
    if (img && source === "local" && img.type !== type) setType(img.type);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [local.data, fp]);
  useEffect(() => {
    if (type === "container" && (source === "iso" || source === "none")) setSource("remote");
    if (type === "virtual-machine" && source === "oci") setSource("remote");
    setAlias("");
  }, [type, source]);

  const isVM = type === "virtual-machine";
  const nameBad = name !== "" && !nameRe.test(name);
  const srcBad = (source === "remote" && !alias) || (source === "local" && !fp) || (source === "oci" && !oci.ref.trim()) || (source === "iso" && !iso);

  const submit = async () => {
    setTried(true);
    if (nameBad || srcBad) {
      shake(body.current?.querySelector<HTMLElement>(".bad") ?? null);
      return;
    }
    const config: Record<string, string> = {};
    if (cpu) config["limits.cpu"] = cpu;
    if (mem) config["limits.memory"] = mem + "GiB";
    if (autostart) config["boot.autostart"] = "true";
    if (nesting && !isVM) config["security.nesting"] = "true";
    if (isVM && !secureboot) config["security.secureboot"] = "false";
    if (cloudInit.trim()) config["cloud-init.user-data"] = cloudInit;
    for (const [k, v] of Object.entries(extra)) if (k) config[k] = v;
    const devices: Record<string, Record<string, string>> = {};
    if (disk || pool) devices.root = { type: "disk", path: "/", pool: pool || pools.data?.[0] || "default", ...(disk ? { size: disk + "GiB" } : {}) };
    if (network) devices.eth0 = { type: "nic", network, name: "eth0" };
    if (source === "iso") {
      const v = isos.data?.find((x) => `${x.pool}/${x.name}` === iso);
      devices.iso = { type: "disk", pool: v?.pool, source: v?.name, "boot.priority": "10" };
    }
    let src: any;
    if (source === "remote") src = { type: "image", alias, server: remoteURL, protocol: "simplestreams", mode: "pull" };
    else if (source === "local") src = { type: "image", fingerprint: fp };
    else if (source === "oci") src = { type: "image", alias: oci.ref.trim(), server: oci.url, protocol: "oci", mode: "pull" };
    else src = { type: "none" };
    const req = { name: name || undefined, type, profiles, config, devices, start, ephemeral, description: desc, source: src };
    onClose();
    const label = name || "an instance";
    const op = await app.run(
      `Creating ${label}`,
      async (progress) => {
        const r = await incusOp(srv, "/1.0/instances", { method: "POST", project, body: req }, progress);
        invalidate("instances:");
        return r;
      },
      `${label} created`,
    );
    const made = name || (op?.resources?.instances?.[0] || "").split("/").pop()?.split("?")[0];
    if (op && made) nav(`/instances/${srv}/${made}?project=${encodeURIComponent(project)}`);
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Create instance"
      wide
      footer={
        <>
          <span className="dim l" style={{ fontSize: 12.5 }}>
            {servers.length > 1 ? `On ${srv}, ` : ""}project {project}
          </span>
          <button className="btn btn-s press" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-p press" onClick={submit}>
            Create{start ? " and start" : ""}
          </button>
        </>
      }
    >
      <div ref={body} style={{ display: "contents" }}>
        <div className="two">
          <Field label="Name" hint={nameBad ? "Start with a letter; use letters, numbers and dashes." : "Leave empty for a random name."} bad={nameBad}>
            <Input autoFocus value={name} onChange={setName} placeholder="web-01" bad={nameBad} />
          </Field>
          {servers.length > 1 ? (
            <Field label="Server">
              <Select value={srv} onChange={setServer} options={servers.map((s) => s.name)} />
            </Field>
          ) : (
            <Field label="Type">
              <TypeSeg type={type} setType={setType} vmOK={vmOK} />
            </Field>
          )}
        </div>
        {servers.length > 1 && (
          <Field label="Type">
            <TypeSeg type={type} setType={setType} vmOK={vmOK} />
          </Field>
        )}

        <SheetSec title="Image">
          <Seg
            value={source}
            onChange={setSource}
            label="Image source"
            options={[
              { v: "remote", l: "Image server" },
              { v: "local", l: `On this server${local.data ? ` (${local.data.filter((i) => i.type === type).length})` : ""}` },
              ...(isVM ? [{ v: "iso" as Source, l: "ISO" }, { v: "none" as Source, l: "Empty" }] : [{ v: "oci" as Source, l: "OCI registry" }]),
            ]}
          />
          {source === "remote" && (
            <>
              <RemotePicker
                server={srv}
                type={type}
                value={alias}
                onPick={(a, img, url) => {
                  setAlias(a);
                  setRemoteURL(url);
                  setVariant(img.variant);
                }}
              />
              {tried && !alias && <div className="hint bad">Pick an image.</div>}
            </>
          )}
          {source === "local" && (
            <>
              <LocalPicker images={local.data} type={type} value={fp} onPick={setFp} />
              {tried && !fp && <div className="hint bad">Pick an image.</div>}
            </>
          )}
          {source === "oci" && (
            <div className="two">
              <Select value={oci.url} onChange={(url) => setOci({ ...oci, url })} options={ociRegistries.map((r) => ({ v: r.url, l: r.name }))} />
              <Input mono value={oci.ref} onChange={(ref) => setOci({ ...oci, ref })} placeholder={ociRegistries.find((r) => r.url === oci.url)?.hint} bad={tried && !oci.ref.trim()} />
            </div>
          )}
          {source === "iso" && (
            <>
              <Select
                value={iso}
                onChange={setIso}
                options={[{ v: "", l: isos.data?.length ? "Choose an ISO" : "No ISOs yet. Upload one under Storage, Custom ISOs." }, ...(isos.data || []).map((v) => ({ v: `${v.pool}/${v.name}`, l: `${v.name} (${v.pool})` }))]}
              />
              <span className="dim" style={{ fontSize: 12.5 }}>
                The VM starts empty and boots the installer from this ISO.
              </span>
            </>
          )}
          {source === "none" && <span className="dim" style={{ fontSize: 12.5 }}>An empty VM with a blank disk. Attach an ISO or install over the network later.</span>}
        </SheetSec>

        <SheetSec title="Resources">
          <div className="three">
            <Field label="CPU cores" hint="Empty uses the profile.">
              <Input inputMode="numeric" mono value={cpu} onChange={(v) => setCpu(v.replace(/\D/g, ""))} placeholder="–" />
            </Field>
            <Field label="Memory (GiB)" hint="Empty uses the profile.">
              <Input inputMode="decimal" mono value={mem} onChange={(v) => setMem(v.replace(/[^\d.]/g, ""))} placeholder="–" />
            </Field>
            <Field label="Root disk (GiB)" hint="Empty uses the pool default.">
              <Input inputMode="numeric" mono value={disk} onChange={(v) => setDisk(v.replace(/\D/g, ""))} placeholder="–" />
            </Field>
          </div>
          <div className="two">
            <Field label="Storage pool">
              <Select value={pool} onChange={setPool} options={[{ v: "", l: "From the profile" }, ...(pools.data || []).map((p) => ({ v: p, l: p }))]} />
            </Field>
            <Field label="Network">
              <Select value={network} onChange={setNetwork} options={[{ v: "", l: "From the profile" }, ...(nets.data || []).map((p) => ({ v: p, l: p }))]} />
            </Field>
          </div>
        </SheetSec>

        <SheetSec title="Profiles">
          <div className="pt">
            {(profs.data || ["default"]).map((p) => (
              <label key={p}>
                <input type="checkbox" checked={profiles.includes(p)} onChange={(e) => setProfiles(e.target.checked ? [...profiles, p] : profiles.filter((x) => x !== p))} />
                {p}
              </label>
            ))}
          </div>
        </SheetSec>

        {(source === "remote" || source === "local") && (
          <SheetSec title="Cloud-init">
            <textarea
              className="yaml box"
              spellCheck={false}
              value={cloudInit}
              onChange={(e) => setCloudInit(e.target.value)}
              placeholder={"#cloud-config\npackages:\n  - curl"}
              style={{ minHeight: 110 }}
            />
            <span className="dim" style={{ fontSize: 12.5 }}>
              {variant === "cloud" || source === "local" ? "User data, run on first boot." : "Only images with cloud in the name run this. Pick a cloud variant above."}
            </span>
          </SheetSec>
        )}

        <SheetSec title="Options">
          <TglRow title="Start with the server" note="Starts this instance when the host boots." on={autostart} onChange={setAutostart} />
          {!isVM && <TglRow title="Nesting" note="Needed to run Docker or Incus inside." on={nesting} onChange={setNesting} />}
          {isVM && <TglRow title="Secure boot" note="Turn off for installers that aren't signed." on={secureboot} onChange={setSecureboot} />}
          <TglRow title="Ephemeral" note="Deleted when it stops." on={ephemeral} onChange={setEphemeral} />
          <TglRow title="Start after creating" on={start} onChange={setStart} />
        </SheetSec>

        <SheetSec title="Description">
          <Input value={desc} onChange={setDesc} placeholder="What runs here" />
        </SheetSec>

        <SheetSec title="More settings">
          <KVEditor value={extra} onChange={setExtra} keys={instanceKeys} />
        </SheetSec>
      </div>
    </Sheet>
  );
}

function TypeSeg({ type, setType, vmOK }: { type: "container" | "virtual-machine"; setType: (t: "container" | "virtual-machine") => void; vmOK: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <Seg
        value={type}
        onChange={setType}
        options={[
          { v: "container", l: <>{ic.ct}Container</> },
          { v: "virtual-machine", l: <>{ic.vm}VM</> },
        ]}
      />
      {!vmOK && type === "virtual-machine" && <span className="hint bad" style={{ fontSize: 12.5 }}>This server can't run VMs.</span>}
    </div>
  );
}

export const instanceKeys = [
  "limits.cpu.allowance",
  "limits.cpu.priority",
  "limits.memory.swap",
  "limits.processes",
  "limits.disk.priority",
  "boot.autostart.delay",
  "boot.autostart.priority",
  "boot.host_shutdown_timeout",
  "security.privileged",
  "security.protection.delete",
  "security.syscalls.intercept.mknod",
  "security.syscalls.intercept.setxattr",
  "snapshots.schedule",
  "snapshots.expiry",
  "environment.TZ",
  "linux.kernel_modules",
  "raw.lxc",
  "raw.qemu",
  "user.comment",
];
