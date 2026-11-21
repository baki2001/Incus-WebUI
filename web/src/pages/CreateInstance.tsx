import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import YAML from "yaml";
import { incus } from "../api";
import { ic } from "../icons";
import { invalidate, useApp, useData, useScopedServers } from "../state";
import { listVolumes, nameOf, useNames } from "../data";
import { confirmDialog, Field, Input, KVEditor, Seg, Select, Sheet, SheetSec, shake, TglRow } from "../ui";
import { cpuOK, friendlyError, hasExt, memBytes, runOp, SizeField, useManagedNetworks } from "./cfgutil";
import { checkDevices, DiskEditor, ProxyEditor, type Devs } from "./DeviceEditors";
import { LocalPicker, ociRegistries, RemotePicker, useImageServers, useRemoteImages, useServerArch } from "./ImagePicker";
import "../cfg.css";

const nameRe = /^[a-zA-Z][a-zA-Z0-9-]{0,62}$/;
type Source = "remote" | "local" | "oci" | "iso" | "none";

export type CreatePreset = { image?: string; server?: string; iso?: string };

export function CreateInstance({ open, onClose, preset }: { open: boolean; onClose: () => void; preset?: CreatePreset }) {
  const app = useApp();
  const nav = useNavigate();
  const servers = useScopedServers();
  const [server, setServer] = useState("");
  const srv = server || servers[0]?.name || "";
  const { vm: vmOK, info } = useServerArch(open ? srv : "");
  const ociOK = hasExt(info, "instance_oci");

  const [proj, setProj] = useState("");
  const projSel = proj || (app.project === "*" ? "" : app.project);
  const project = projSel || "default"; // for lookups before one is chosen
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
  const [devs, setDevs] = useState<Devs>({});
  const [showYaml, setShowYaml] = useState(false);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [err, setErr] = useState("");
  const body = useRef<HTMLDivElement>(null);
  const userSrc = useRef(false);
  const openRef = useRef(open);
  openRef.current = open;
  const edit = (fn: (d: Devs) => void) =>
    setDevs((p) => {
      const n = JSON.parse(JSON.stringify(p));
      fn(n);
      return n;
    });

  const local = useData<any[]>(open && srv ? `images:${srv}:${project}` : null, () => incus(srv, "/1.0/images?recursion=1", { project }));
  const profs = useNames(open ? srv : "", "profiles", project);
  const pools = useNames(open ? srv : "", "storage-pools", project);
  const projects = useNames(open ? srv : "", "projects");
  const nets = useManagedNetworks(open ? srv : "", project);
  const taken = useData<string[]>(open && srv && projSel ? `instance-names:${srv}:${projSel}` : null, async () => ((await incus<string[]>(srv, "/1.0/instances", { project: projSel })) || []).map(nameOf));
  const isos = useData<any[]>(open && srv && type === "virtual-machine" ? `isos:${srv}:${project}` : null, async () =>
    (await listVolumes(srv, project)).filter((v) => v.content_type === "iso"),
  );
  // If the image server can't be reached, start on the images already here.
  const imgServers = useImageServers();
  const firstRemote = useRemoteImages(open ? imgServers.data?.[0]?.url : undefined);

  useEffect(() => {
    if (open) {
      setName("");
      setProj("");
      setServer("");
      setType("container");
      setSource("remote");
      setAlias("");
      setFp("");
      setOci({ url: ociRegistries[0].url, ref: "" });
      setIso("");
      setProfiles(["default"]);
      setCpu("");
      setMem("");
      setDisk("");
      setPool("");
      setNetwork("");
      setCloudInit("");
      setDesc("");
      setStart(true);
      setAutostart(false);
      setNesting(false);
      setEphemeral(false);
      setSecureboot(true);
      setExtra({});
      setDevs({});
      setShowYaml(false);
      setTried(false);
      setErr("");
      userSrc.current = !!(preset?.image || preset?.iso);
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
  useEffect(() => {
    if (open && !userSrc.current && firstRemote.error && source === "remote") setSource("local");
  }, [open, firstRemote.error, source]);
  // An image picked from the Images page decides the type.
  useEffect(() => {
    const img = local.data?.find((i) => i.fingerprint === fp);
    if (img && source === "local" && img.type !== type) setType(img.type);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [local.data, fp]);
  useEffect(() => {
    if (type === "container" && (source === "iso" || source === "none")) setSource("remote");
    if ((type === "virtual-machine" && source === "oci") || (source === "oci" && info && !ociOK)) setSource("remote");
    setAlias("");
  }, [type, source, info, ociOK]);

  const isVM = type === "virtual-machine";
  const dup = name !== "" && !!taken.data?.includes(name);
  const nameBad = (name !== "" && !nameRe.test(name)) || dup;
  const srcBad = (source === "remote" && !alias) || (source === "local" && !fp) || (source === "oci" && !oci.ref.trim()) || (source === "iso" && !iso);
  const cpuBad = cpu !== "" && !cpuOK(cpu);
  const sizeBad = (v: string) => v !== "" && !((memBytes(v) ?? 0) > 0);
  const devErrs = checkDevices(devs);
  const hasErr = nameBad || srcBad || !projSel || cpuBad || sizeBad(mem) || sizeBad(disk) || Object.keys(devErrs).length > 0;
  const dirty =
    !!(name || alias || fp || oci.ref || iso || cpu || mem || disk || pool || network || cloudInit || desc || proj) ||
    profiles.join() !== "default" ||
    autostart ||
    nesting ||
    ephemeral ||
    !start ||
    !secureboot ||
    Object.keys(extra).length > 0 ||
    Object.keys(devs).length > 0;

  const request = () => {
    const config: Record<string, string> = {};
    if (cpu) config["limits.cpu"] = cpu;
    if (mem) config["limits.memory"] = mem;
    if (autostart) config["boot.autostart"] = "true";
    if (nesting && !isVM) config["security.nesting"] = "true";
    if (isVM && !secureboot) config["security.secureboot"] = "false";
    if (cloudInit.trim()) config["cloud-init.user-data"] = cloudInit;
    for (const [k, v] of Object.entries(extra)) if (k) config[k] = v;
    const devices: Devs = {};
    if (disk || pool) devices.root = { type: "disk", path: "/", pool: pool || pools.data?.[0] || "default", ...(disk ? { size: disk } : {}) };
    if (network) devices.eth0 = { type: "nic", network, name: "eth0" };
    if (source === "iso") {
      const v = isos.data?.find((x) => `${x.pool}/${x.name}` === iso);
      devices.iso = { type: "disk", pool: v?.pool, source: v?.name, "boot.priority": "10" };
    }
    Object.assign(devices, devs);
    let src: any;
    if (source === "remote") src = { type: "image", alias, server: remoteURL, protocol: "simplestreams", mode: "pull" };
    else if (source === "local") src = { type: "image", fingerprint: fp };
    else if (source === "oci") src = { type: "image", alias: oci.ref.trim(), server: oci.url, protocol: "oci", mode: "pull" };
    else src = { type: "none" };
    return { name: name || undefined, type, profiles, config, devices, start, ephemeral, description: desc, source: src };
  };

  const close = async () => {
    if (busy || !dirty || (await confirmDialog({ title: "Discard your changes?", body: "This instance has not been created yet.", confirm: "Discard", danger: true }))) onClose();
  };

  const submit = async () => {
    setTried(true);
    setErr("");
    if (hasErr) {
      requestAnimationFrame(() => shake(body.current?.querySelector<HTMLElement>(".fl .hint.bad, .field.bad") ?? null));
      return;
    }
    const label = name || "The instance";
    setBusy(true);
    try {
      const op = await runOp(srv, "/1.0/instances", { method: "POST", project: projSel, body: request() }, setProgress);
      invalidate("instances:");
      const made = name || (op?.resources?.instances?.[0] || "").split("/").pop()?.split("?")[0];
      app.toast(`${label} created`);
      if (openRef.current) onClose();
      if (made) nav(`/instances/${srv}/${made}?project=${encodeURIComponent(projSel)}`);
    } catch (e) {
      const m = friendlyError(e);
      if (openRef.current) {
        setErr(m);
        requestAnimationFrame(() => body.current?.querySelector(".cerr")?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
      } else app.toast(`Creating ${label.toLowerCase()} failed: ${m}`);
    } finally {
      setBusy(false);
      setProgress("");
    }
  };

  const pickSource = (v: Source) => {
    userSrc.current = true;
    setSource(v);
  };

  return (
    <Sheet
      open={open}
      onClose={close}
      title="Create instance"
      wide
      footer={
        <>
          <span className="dim l" style={{ fontSize: 12.5 }}>
            {busy ? progress || "Creating…" : `${servers.length > 1 ? `On ${srv}, ` : ""}${projSel ? `project ${projSel}` : "choose a project"}`}
          </span>
          <button className="btn btn-s press" onClick={close}>
            Cancel
          </button>
          <button className="btn btn-p press" onClick={submit} disabled={busy}>
            {busy ? "Creating…" : `Create${start ? " and start" : ""}`}
          </button>
        </>
      }
    >
      <div ref={body} style={{ display: "contents" }}>
        {err && (
          <div className="cerr stick" role="alert">
            Couldn't create the instance. {err}
          </div>
        )}
        <div className="two">
          <Field
            label="Name"
            hint={dup ? `An instance named ${name} already exists in project ${projSel}.` : nameBad ? "Start with a letter; use letters, numbers and dashes." : "Leave empty for a random name."}
            bad={nameBad}
          >
            <Input autoFocus value={name} onChange={setName} placeholder="web-01" bad={nameBad} />
          </Field>
          <Field label="Project" hint={tried && !projSel ? "Choose the project to create it in." : ""} bad={tried && !projSel}>
            <Select
              value={projSel}
              onChange={setProj}
              options={[...(projSel ? [] : [{ v: "", l: "Choose a project" }]), ...(projects.data || (projSel ? [projSel] : [])).map((p) => ({ v: p, l: p }))]}
              aria-label="Project"
            />
          </Field>
        </div>
        <div className="two">
          <Field label="Type">
            <TypeSeg type={type} setType={setType} vmOK={vmOK} />
          </Field>
          {servers.length > 1 && (
            <Field label="Server">
              <Select value={srv} onChange={setServer} options={servers.map((s) => s.name)} />
            </Field>
          )}
        </div>

        <SheetSec title="Image">
          <Seg
            value={source}
            onChange={pickSource}
            label="Image source"
            options={[
              { v: "remote", l: "Image server" },
              { v: "local", l: `On this server${local.data ? ` (${local.data.filter((i) => i.type === type).length})` : ""}` },
              ...(isVM ? [{ v: "iso" as Source, l: "ISO" }, { v: "none" as Source, l: "Empty" }] : ociOK ? [{ v: "oci" as Source, l: "OCI registry" }] : []),
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
          <div className="two">
            <Field label="CPU cores" hint={cpuBad ? "Enter a number of cores like 2, or a range like 0-3." : "Empty uses the profile."} bad={cpuBad}>
              <Input mono value={cpu} onChange={(v) => setCpu(v.replace(/[^\d,-]/g, ""))} placeholder="–" bad={cpuBad} aria-label="CPU cores" />
            </Field>
            <Field label="Memory" hint={sizeBad(mem) ? "Enter a size above 0, like 512 MiB or 2 GiB." : "Empty uses the profile."} bad={sizeBad(mem)}>
              <SizeField label="Memory" value={mem} onChange={setMem} placeholder="–" bad={sizeBad(mem)} />
            </Field>
          </div>
          <div className="two">
            <Field label="Root disk" hint={sizeBad(disk) ? "Enter a size above 0, like 20 GiB." : "Empty uses the pool default."} bad={sizeBad(disk)}>
              <SizeField label="Root disk" value={disk} onChange={setDisk} placeholder="–" bad={sizeBad(disk)} />
            </Field>
            <Field label="Storage pool">
              <Select value={pool} onChange={setPool} options={[{ v: "", l: "From the profile" }, ...(pools.data || []).map((p) => ({ v: p, l: p }))]} />
            </Field>
          </div>
          <Field label="Network" hint="Managed networks only. Add a host interface (macvlan) after creating, under Configuration.">
            <Select value={network} onChange={setNetwork} options={[{ v: "", l: "From the profile" }, ...(nets.data || []).map((p) => ({ v: p.name, l: p.name }))]} />
          </Field>
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

        <SheetSec title="Extra disks">
          <DiskEditor devices={devs} edit={edit} server={srv} project={project} errors={tried ? devErrs : {}} />
        </SheetSec>

        <SheetSec title="Port forwarding">
          <ProxyEditor devices={devs} edit={edit} server={srv} errors={tried ? devErrs : {}} />
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

        <SheetSec
          title="YAML"
          action={
            <button type="button" className="btn btn-q btn-sm" onClick={() => setShowYaml(!showYaml)} aria-expanded={showYaml}>
              {showYaml ? "Hide" : "Show"}
            </button>
          }
        >
          {showYaml && (
            <div className="ysec">
              <textarea className="yaml" readOnly spellCheck={false} aria-label="Instance configuration as YAML" value={YAML.stringify(request())} />
              <span className="dim" style={{ fontSize: 12.5 }}>
                What will be sent to the server. Read only; change it with the fields above.
              </span>
            </div>
          )}
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
