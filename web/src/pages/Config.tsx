import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import YAML from "yaml";
import { ApiError, bytes, friendlyError, incus, incusOp, incusWithETag, memBytes, memStr, type Instance } from "../api";
import { ic } from "../icons";
import { invalidate, useApp, useData } from "../state";
import { Dialog, Seg, shake, Toggle, usePresence } from "../ui";
import { CONFLICT, cpuCount, cpuOK, fixedIPv4Net, lanNic, lanParents, nicIPv4Error, SizeField, subnetOf, useNetworkList } from "./cfgutil";
import { checkDevices, DiskEditor, ProxyEditor, type Dev, type Devs, type Inherited } from "./DeviceEditors";
import "../cfg.css";

type Inst = Instance & { server: string };
type Put = { description: string; profiles: string[]; config: Record<string, string>; devices: Devs };

const hidden = (k: string) => k.startsWith("volatile.") || k.startsWith("image.");
function toPut(i: { description?: string; profiles: string[]; config?: Record<string, string>; devices?: Devs }): Put {
  const config: Record<string, string> = {};
  for (const [k, v] of Object.entries(i.config || {})) if (!hidden(k)) config[k] = v;
  return { description: i.description || "", profiles: [...i.profiles], config, devices: JSON.parse(JSON.stringify(i.devices || {})) };
}

// Empty values mean "not set here"; they never go to the server or the diff.
function clean(d: Put): Put {
  return { ...d, config: Object.fromEntries(Object.entries(d.config).filter(([, v]) => v !== "")) };
}

// line diff (LCS), good enough for config-sized YAML
export function diffLines(a: string, b: string) {
  const x = a.split("\n"),
    y = b.split("\n");
  const n = x.length,
    m = y.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: { t: "a" | "r" | "c"; s: string }[] = [];
  let i = 0,
    j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) (out.push({ t: "c", s: x[i] }), i++, j++);
    else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) (out.push({ t: "a", s: "+ " + y[j] }), j++);
    else (out.push({ t: "r", s: "- " + x[i] }), i++);
  }
  return out;
}

const sched = [
  { v: "", l: "Off" },
  { v: "@hourly", l: "Every hour" },
  { v: "@daily", l: "Daily" },
  { v: "0 3 * * *", l: "Daily at 03:00" },
  { v: "@weekly", l: "Weekly" },
];
const expiry = ["", "1d", "3d", "7d", "14d", "4w", "3M"];


function validate(d: Put, cores?: number, hostMem?: number, nets?: any[]) {
  const err: Record<string, string> = {},
    warn: Record<string, string> = {};
  const cpu = d.config["limits.cpu"];
  if (cpu) {
    if (!cpuOK(cpu)) err.cpu = cpu.startsWith("-") ? "Cores can't be negative." : cpu === "0" ? "Use at least 1 core, or remove the limit." : "Enter a number of cores like 2, or a range like 0-3.";
    else if (cores && cpuCount(cpu) > cores) warn.cpu = `This host only has ${cores} threads.`;
  }
  const size = (v: string | undefined, what: string, key: string, max?: number) => {
    if (!v || /^\d+(\.\d+)?%$/.test(v)) return;
    const b = memBytes(v);
    if (b == null || b <= 0) err[key] = v.startsWith("-") ? `${what} can't be negative.` : `Enter a size above 0, like 512 MiB or 2 GiB.`;
    else if (max && b > max) warn[key] = `This host only has ${bytes(max)} of memory.`;
  };
  size(d.config["limits.memory"], "Memory", "mem", hostMem);
  size(d.devices.root?.size, "Disk size", "root");
  Object.assign(err, checkDevices(d.devices));
  for (const [n, dev] of Object.entries(d.devices)) {
    const e = dev.type === "nic" && nicIPv4Error(dev, nets);
    if (e) err["dev." + n] = e;
  }
  return { err, warn };
}

type NetDev = { n: string; d: Dev; from: string | null };

export function ConfigTab({ inst, reload }: { inst: Inst; reload: () => void }) {
  const app = useApp();
  const { server, project, name } = inst;
  const path = `/1.0/instances/${encodeURIComponent(name)}`;
  const root = useRef<HTMLDivElement>(null);
  const [base, setBase] = useState<{ obj: any; etag: string } | null>(null);
  const srcObj = base?.obj ?? inst;
  const original = useMemo(() => toPut(srcObj), [srcObj]);
  const [draft, setDraft] = useState<Put>(original);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const [view, setView] = useState<"form" | "yaml">("form");
  const [yamlText, setYamlText] = useState("");
  const [yamlErr, setYamlErr] = useState("");
  const [review, setReview] = useState(false);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [applyErr, setApplyErr] = useState("");
  const [conflict, setConflict] = useState(false);
  const host = useData<any>(`resources:${server}`, () => incus(server, "/1.0/resources"));
  const pools = useData<string[]>(`pools:${server}:${project}`, async () => (await incus<string[]>(server, "/1.0/storage-pools", { project })).map((p) => p.split("/").pop()!));
  const nets = useNetworkList(server, project);
  const profs = useData<any[]>(`profiles-full:${server}:${project}`, async () => (await incus<any[]>(server, "/1.0/profiles?recursion=1", { project })) || []);

  // The version we edit from, with its ETag so a save can't overwrite someone else's change.
  const loadBase = useCallback(async () => {
    const r = await incusWithETag<any>(server, path, { project });
    setBase((old) => (old && old.etag === r.etag && JSON.stringify(old.obj) === JSON.stringify(r.data) ? old : { obj: r.data, etag: r.etag }));
  }, [server, path, project]);
  useEffect(() => {
    loadBase().catch(() => {});
    const t = window.setInterval(() => !document.hidden && !dirtyRef.current && loadBase().catch(() => {}), 5000);
    return () => clearInterval(t);
  }, [loadBase]);

  // keep in sync with the server while nothing is edited
  useEffect(() => {
    if (!dirty) setDraft(original);
  }, [original, dirty]);

  const upd = (fn: (d: Put) => void) => {
    setDraft((prev) => {
      const next: Put = JSON.parse(JSON.stringify(prev));
      fn(next);
      return next;
    });
    setDirty(true);
  };
  const edit = (fn: (d: Devs) => void) => upd((d) => fn(d.devices));
  const setCfg = (k: string, v: string) => upd((d) => void (d.config[k] = v));
  const resetCfg = (k: string) => upd((d) => void delete d.config[k]);

  // What the chosen profiles provide, in order (later ones win).
  const prof = useMemo(() => {
    const cfg: Record<string, string> = {},
      cfgFrom: Record<string, string> = {},
      dev: Devs = {},
      devFrom: Record<string, string> = {};
    if (profs.data) {
      for (const pn of draft.profiles) {
        const p = profs.data.find((x) => x.name === pn);
        if (!p) continue;
        for (const [k, v] of Object.entries<string>(p.config || {})) ((cfg[k] = v), (cfgFrom[k] = pn));
        for (const [k, v] of Object.entries<Dev>(p.devices || {})) ((dev[k] = v), (devFrom[k] = pn));
      }
    } else {
      Object.assign(cfg, srcObj.expanded_config || {});
      Object.assign(dev, srcObj.expanded_devices || {});
      for (const k of Object.keys(cfg)) cfgFrom[k] = "a profile";
      for (const k of Object.keys(dev)) devFrom[k] = "a profile";
    }
    return { cfg, cfgFrom, dev, devFrom };
  }, [profs.data, draft.profiles, srcObj]);

  const cd = useMemo(() => clean(draft), [draft]);
  const own = (k: string) => (draft.config[k] ?? "") !== "";
  const val = (k: string) => (k in draft.config ? draft.config[k] : (prof.cfg[k] ?? ""));
  const eff = (k: string) => draft.config[k] || prof.cfg[k] || "";
  const from = (k: string) => (own(k) ? (k in prof.cfg ? `Set on this instance, overrides ${prof.cfgFrom[k]}` : "Set on this instance") : k in prof.cfg ? `From profile ${prof.cfgFrom[k]}` : "");
  const changed = (k: string) => (cd.config[k] ?? "") !== (original.config[k] ?? "");
  const onlyProfile = (k: string) => !own(k) && k in prof.cfg;
  const useProfile = (k: string) =>
    own(k) && k in prof.cfg ? (
      <button className="btn btn-s btn-sm" onClick={() => resetCfg(k)}>
        Use profile value
      </button>
    ) : null;

  const origY = useMemo(() => YAML.stringify(original), [original]);
  const nChanges = useMemo(() => {
    const keys = (a: Record<string, unknown>, b: Record<string, unknown>) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).length;
    return keys(original.config, cd.config) + keys(original.devices, cd.devices) + (original.description !== cd.description ? 1 : 0) + (original.profiles.join() !== cd.profiles.join() ? 1 : 0);
  }, [original, cd]);

  const cores = host.data?.cpu?.total;
  const hostMem = host.data?.memory?.total;
  const { err: errs, warn: warns } = useMemo(() => validate(cd, cores, hostMem, nets.data), [cd, cores, hostMem, nets.data]);
  const devErrs = tried ? errs : {};

  const parseYaml = (): Put | null => {
    try {
      const p = YAML.parse(yamlText) as Put;
      return { description: p?.description || "", profiles: p?.profiles || [], config: p?.config || {}, devices: p?.devices || {} };
    } catch (e: any) {
      setYamlErr(e.message);
      return null;
    }
  };
  const switchView = (v: "form" | "yaml") => {
    if (v === "yaml") {
      setYamlText(YAML.stringify(cd));
      setYamlErr("");
    } else if (view === "yaml") {
      const p = parseYaml();
      if (!p) return;
      setDraft(p);
      setDirty(true);
    }
    setView(v);
  };
  const startReview = () => {
    let d = cd;
    if (view === "yaml") {
      const p = parseYaml();
      if (!p) return;
      setDraft(p);
      setYamlErr("");
      d = clean(p);
    }
    const v = validate(d, cores, hostMem, nets.data);
    if (Object.keys(v.err).length) {
      setTried(true);
      if (view === "yaml") setYamlErr(Object.values(v.err)[0]);
      else requestAnimationFrame(() => shake(root.current?.querySelector<HTMLElement>(".hc .field.bad, [data-bad]") ?? null));
      return;
    }
    setApplyErr("");
    setReview(true);
  };

  const apply = async () => {
    if (!base) return;
    setBusy(true);
    setApplyErr("");
    // The server fills in volatile.* and image.* itself; send them back unchanged but keep them out of the draft.
    const body = JSON.parse(JSON.stringify({ ...cd, architecture: srcObj.architecture, ephemeral: srcObj.ephemeral, stateful: srcObj.stateful }));
    for (const [k, v] of Object.entries<string>(srcObj.config || {})) if (hidden(k)) body.config[k] = v;
    for (const k of ["limits.memory", "limits.memory.swap"]) {
      const b = body.config[k] && !body.config[k].endsWith("%") ? memBytes(body.config[k]) : null;
      if (b) body.config[k] = memStr(Math.round(b));
    }
    const rs = body.devices.root?.size ? memBytes(body.devices.root.size) : null;
    if (rs) body.devices.root.size = memStr(Math.round(rs));
    const put = (etag: string) => incusOp(server, path, { method: "PUT", project, body, etag });
    try {
      try {
        await put(base.etag);
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 412)) throw e;
        // volatile.* changes when the instance starts or stops; only a real change is a conflict
        const fresh = await incusWithETag<any>(server, path, { project });
        if (JSON.stringify(toPut(fresh.data)) !== JSON.stringify(original)) throw e;
        for (const [k, v] of Object.entries<string>(fresh.data.config || {})) if (hidden(k)) body.config[k] = v;
        await put(fresh.etag);
      }
      setReview(false);
      setDirty(false);
      setTried(false);
      app.toast("Changes applied");
      invalidate("instances:");
      await loadBase().catch(() => {});
      reload();
    } catch (e) {
      if (e instanceof ApiError && e.status === 412) {
        setReview(false);
        setConflict(true);
      } else setApplyErr(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };
  const reloadFromServer = async () => {
    await loadBase().catch(() => {});
    setDirty(false);
    setTried(false);
    setConflict(false);
    setView("form");
  };

  // ----- derived values for the form -----
  const cpu = val("limits.cpu");
  const memV = val("limits.memory");
  const memB = memBytes(memV);
  const hard = (eff("limits.memory.enforce") || "hard") === "hard";
  const rootLocal = draft.devices.root;
  const rootEff = rootLocal || prof.dev.root || {};
  const rootSize = rootLocal ? (rootLocal.size ?? "") : (prof.dev.root?.size ?? "");
  const isVM = inst.type === "virtual-machine";
  const effDev: Devs = { ...prof.dev, ...draft.devices };
  const inh = (type: string): Inherited => Object.entries(prof.dev).filter(([n, d]) => d.type === type && n !== "root" && !draft.devices[n]).map(([n, d]) => [n, d, prof.devFrom[n]]);
  const nicRows: NetDev[] = Object.entries(effDev)
    .filter(([, d]) => d.type === "nic")
    .map(([n, d]) => ({ n, d, from: draft.devices[n] ? null : prof.devFrom[n] }));
  const managedNets = (nets.data || []).filter((n) => n.managed);
  const managed = managedNets.map((n) => n.name as string);
  const hostNics = (nets.data || []).filter((n) => !n.managed && n.type !== "loopback").map((n) => n.name as string);
  const lans = lanParents(nets.data);
  const autostart = (eff("boot.autostart") || "false") === "true";
  const nesting = (eff("security.nesting") || "false") === "true";
  const schedV = eff("snapshots.schedule");
  const allProfiles = (profs.data || []).map((p) => p.name as string);
  const chgDev = (n: string) => JSON.stringify(cd.devices[n]) !== JSON.stringify(original.devices[n]);

  const hwbar = usePresence(dirty && (nChanges > 0 || view === "yaml"));

  if (!base && !inst.config) return <div className="hw" />;

  return (
    <div className="hw" ref={root}>
      <div className="cfg-h">
        <Seg value={view} onChange={switchView} options={[{ v: "form", l: "Form" }, { v: "yaml", l: "YAML" }]} />
      </div>
      {conflict && (
        <div className="cfl" role="alert">
          <span>
            <b>{CONFLICT.split(" while")[0]}.</b> {name} changed while you were editing, so your changes were not applied. Reload to see their change, then make your edits again.
          </span>
          <button className="btn btn-s btn-sm press" onClick={() => setConflict(false)}>
            Keep editing
          </button>
          <button className="btn btn-p btn-sm press" onClick={reloadFromServer}>
            Reload
          </button>
        </div>
      )}
      {view === "yaml" ? (
        <div className="panel">
          <textarea className="yaml" spellCheck={false} aria-label="Instance configuration as YAML" value={yamlText} onChange={(e) => (setYamlText(e.target.value), setDirty(true))} />
          {yamlErr && <div className="pfoot bad">{yamlErr}</div>}
        </div>
      ) : (
        <>
          <section className="hsec">
            <header>
              <h2>Compute</h2>
            </header>
            <div className={"hrow" + (errs.cpu ? " bad" : "")}>
              <div className="hl">
                <b title="limits.cpu">CPU{changed("limits.cpu") && <span className="chg" />}</b>
                {from("limits.cpu") && <span className="from">{from("limits.cpu")}</span>}
              </div>
              <div className="hc">
                <div className="line">
                  <div className={"step" + (errs.cpu ? " bad" : "")}>
                    <button type="button" aria-label="Fewer" onClick={() => setCfg("limits.cpu", String(Math.max(1, (Number(cpu) || 2) - 1)))}>
                      −
                    </button>
                    <input aria-label="CPU cores" style={{ width: 64 }} value={cpu} placeholder="all" onChange={(e) => setCfg("limits.cpu", e.target.value.replace(/\s/g, ""))} />
                    <button type="button" aria-label="More" onClick={() => setCfg("limits.cpu", String((Number(cpu) || 0) + 1))}>
                      +
                    </button>
                  </div>
                  {cores && <span className="dim">of {cores}</span>}
                  {own("limits.cpu") && !("limits.cpu" in prof.cfg) && (
                    <button className="btn btn-s btn-sm" onClick={() => resetCfg("limits.cpu")}>
                      Remove limit
                    </button>
                  )}
                  {useProfile("limits.cpu")}
                </div>
                {errs.cpu ? (
                  <span className="note bad" data-bad>
                    {errs.cpu}
                  </span>
                ) : warns.cpu ? (
                  <span className="note warn">{warns.cpu} You can still apply it.</span>
                ) : null}
                <span className="note">{isVM ? "Applies on the next restart for VMs." : "Applies right away, no restart."} Empty means all cores.</span>
              </div>
            </div>
            <div className={"hrow" + (errs.mem ? " bad" : "")}>
              <div className="hl">
                <b title="limits.memory, limits.memory.enforce">Memory{(changed("limits.memory") || changed("limits.memory.enforce")) && <span className="chg" />}</b>
                {from("limits.memory") && <span className="from">{from("limits.memory")}</span>}
              </div>
              <div className="hc">
                <div className="line">
                  {hostMem && (
                    <input
                      type="range"
                      aria-label="Memory slider"
                      min={256}
                      max={Math.max(256, Math.floor(hostMem / 1024 ** 2))}
                      step={256}
                      value={memB ? Math.round(memB / 1024 ** 2) : 256}
                      onChange={(e) => setCfg("limits.memory", memStr(Number(e.target.value) * 1024 ** 2))}
                    />
                  )}
                  {/%$/.test(memV) ? (
                    <div className="field" style={{ width: 110 }}>
                      <input aria-label="Memory" className="mono" value={memV} onChange={(e) => setCfg("limits.memory", e.target.value)} />
                    </div>
                  ) : (
                    <SizeField label="Memory" value={memV} onChange={(v) => setCfg("limits.memory", v)} placeholder="no limit" bad={!!errs.mem} />
                  )}
                  {own("limits.memory") && !("limits.memory" in prof.cfg) && (
                    <button className="btn btn-s btn-sm" onClick={() => resetCfg("limits.memory")}>
                      Remove limit
                    </button>
                  )}
                  {useProfile("limits.memory")}
                </div>
                {errs.mem ? (
                  <span className="note bad" data-bad>
                    {errs.mem}
                  </span>
                ) : warns.mem ? (
                  <span className="note warn">{warns.mem} You can still apply it.</span>
                ) : null}
                {!isVM && (
                  <div className="line">
                    <Seg value={hard ? "hard" : "soft"} onChange={(v) => setCfg("limits.memory.enforce", v)} options={[{ v: "hard", l: "Hard limit" }, { v: "soft", l: "Soft limit" }]} />
                    <span className="note">{hard ? "Never uses more than this." : "Can use more while the host has memory free."}</span>
                  </div>
                )}
              </div>
            </div>
          </section>

          <section className="hsec">
            <header>
              <h2>Storage</h2>
            </header>
            <div className={"hrow" + (errs.root ? " bad" : "")}>
              <div className="hl">
                <b title="devices.root.size">Root disk{JSON.stringify(cd.devices.root) !== JSON.stringify(original.devices.root) && <span className="chg" />}</b>
                {(() => {
                  const f = rootLocal?.size
                    ? prof.dev.root?.size
                      ? `Set on this instance, overrides ${prof.devFrom.root}`
                      : "Set on this instance"
                    : prof.dev.root?.size
                      ? `From profile ${prof.devFrom.root}`
                      : rootLocal
                        ? "Set on this instance"
                        : "";
                  return f ? <span className="from">{f}</span> : null;
                })()}
              </div>
              <div className="hc">
                <div className="line">
                  <SizeField
                    label="Root disk size"
                    value={rootSize}
                    placeholder="pool default"
                    bad={!!errs.root}
                    onChange={(v) =>
                      upd((d) => {
                        const b = d.devices.root || { ...(prof.dev.root || { type: "disk", path: "/", pool: pools.data?.[0] || "default" }) };
                        if (v) b.size = v;
                        else delete b.size;
                        d.devices.root = b;
                      })
                    }
                  />
                  <span className="dim">
                    on pool <span className="tag">{rootEff.pool || "–"}</span>
                  </span>
                </div>
                {errs.root && (
                  <span className="note bad" data-bad>
                    {errs.root}
                  </span>
                )}
                <span className="note">Disks can grow, not shrink.</span>
              </div>
            </div>
            <div className="hrow">
              <div className="hl">
                <b title="devices.*.type: disk">Extra disks{[...new Set([...Object.keys(cd.devices), ...Object.keys(original.devices)])].some((n) => n !== "root" && (cd.devices[n]?.type === "disk" || original.devices[n]?.type === "disk") && chgDev(n)) && <span className="chg" />}</b>
              </div>
              <DiskEditor devices={draft.devices} inherited={inh("disk")} edit={edit} server={server} project={project} errors={devErrs} />
            </div>
          </section>

          <section className="hsec">
            <header>
              <h2>Network</h2>
            </header>
            <div className="hrow">
              <div className="hl">
                <b title="devices.*.type: nic">Network cards</b>
              </div>
              <div className="hc devl">
                {nicRows.map(({ n, d, from: pf }) => {
                  const hostMode = !d.network;
                  const dis = pf != null;
                  const lan = lans.find((l) => l.name === d.parent && lanNic(l, n).nictype === d.nictype);
                  const pick = !hostMode ? d.network : lan ? "host:" + lan.name : "__host";
                  const fixedNet = fixedIPv4Net(d, nets.data);
                  const netRow = (nets.data || []).find((x) => x.name === d.network);
                  const onLan = hostMode || (netRow && !fixedNet);
                  const mac = d.hwaddr || inst.config?.["volatile." + n + ".hwaddr"];
                  const macvlan = hostMode ? d.nictype === "macvlan" || !d.nictype : netRow?.type === "macvlan";
                  return (
                    <div key={n} className="devgrp">
                      <div className="dev n">
                        <div className="field mono-in">
                          <input value={n} readOnly aria-label="Device name" />
                        </div>
                        <div className="field">
                          <select
                            aria-label={`Network of ${n}`}
                            value={pick}
                            disabled={dis}
                            onChange={(e) =>
                              upd((x) => {
                                const v = e.target.value;
                                const l = lans.find((h) => "host:" + h.name === v);
                                x.devices[n] = l ? lanNic(l, d.name || n) : v === "__host" ? { type: "nic", nictype: "macvlan", parent: hostNics[0] || "", name: d.name || n } : { type: "nic", network: v, name: d.name || n };
                              })
                            }
                          >
                            <optgroup label="Incus networks">
                              {managedNets.map((m) => (
                                <option key={m.name} value={m.name}>
                                  {m.type === "bridge" || m.type === "ovn" ? m.name : `${m.name} (${m.type}${m.config?.parent ? " on " + m.config.parent : ""})`}
                                </option>
                              ))}
                              {d.network && !managed.includes(d.network) && <option>{d.network}</option>}
                            </optgroup>
                            <optgroup label="Your LAN, through the host">
                              {lans.map((l) => (
                                <option key={l.name} value={"host:" + l.name}>
                                  {l.name} ({l.type === "bridge" ? "host bridge" : "macvlan"})
                                </option>
                              ))}
                              <option value="__host">Other host interface…</option>
                            </optgroup>
                          </select>
                        </div>
                        {fixedNet ? (
                          <div className="field mono-in">
                            <input
                              aria-label={`IPv4 address of ${n}`}
                              value={d["ipv4.address"] || ""}
                              placeholder="Automatic (DHCP)"
                              disabled={dis}
                              onChange={(e) =>
                                upd((x) => {
                                  if (e.target.value) x.devices[n]["ipv4.address"] = e.target.value;
                                  else delete x.devices[n]["ipv4.address"];
                                })
                              }
                            />
                          </div>
                        ) : (
                          <span className="note">{onLan ? "Address from your LAN" : "–"}</span>
                        )}
                        {dis ? (
                          <button className="btn btn-q btn-sm" title={`From profile ${pf}. Copy to this instance to edit.`} onClick={() => upd((x) => void (x.devices[n] = { ...d }))}>
                            Edit
                          </button>
                        ) : (
                          <button className="btn btn-q ib btn-sm" aria-label={"Remove " + n} onClick={() => upd((x) => void delete x.devices[n])}>
                            {ic.x}
                          </button>
                        )}
                      </div>
                      {pick === "__host" && (
                        <div className="line" style={{ marginTop: 6 }}>
                          <div className="field" style={{ width: 150, height: 30 }}>
                            <select aria-label={`Type of ${n}`} disabled={dis} value={d.nictype || "macvlan"} onChange={(e) => upd((x) => void (x.devices[n].nictype = e.target.value))}>
                              <option value="macvlan">macvlan</option>
                              <option value="physical">physical</option>
                              <option value="bridged">bridged (host bridge)</option>
                            </select>
                          </div>
                          <span className="dim">on host interface</span>
                          <div className="field mono-in" style={{ width: 160, height: 30 }}>
                            <input aria-label={`Host interface of ${n}`} list={"hn-" + n} disabled={dis} value={d.parent || ""} onChange={(e) => upd((x) => void (x.devices[n].parent = e.target.value))} placeholder="eth0" />
                            <datalist id={"hn-" + n}>
                              {hostNics.map((h) => (
                                <option key={h} value={h} />
                              ))}
                            </datalist>
                          </div>
                        </div>
                      )}
                      {devErrs["dev." + n] ? (
                        <span className="note bad" data-bad>
                          {devErrs["dev." + n]}
                        </span>
                      ) : fixedNet && subnetOf(fixedNet) ? (
                        <span className="note">Fixed addresses go in {subnetOf(fixedNet)}.</span>
                      ) : onLan ? (
                        <span className="note">
                          Your router's DHCP gives this card its address.{" "}
                          {mac ? (
                            <>
                              For a fixed one, reserve <span className="mono">{mac}</span> in your router
                            </>
                          ) : (
                            "For a fixed one, reserve its MAC address in your router after the first start"
                          )}
                          , or set it inside the instance.{macvlan && " The host itself can't reach the instance over macvlan; a host bridge can."}
                        </span>
                      ) : null}
                      {dis && <span className="note">From profile {pf}</span>}
                    </div>
                  );
                })}
                <div>
                  <button
                    className="btn btn-s btn-sm press"
                    onClick={() =>
                      upd((x) => {
                        let i = 0;
                        while (x.devices["eth" + i] || prof.dev["eth" + i]) i++;
                        x.devices["eth" + i] = { type: "nic", network: managed[0] || "incusbr0", name: "eth" + i };
                      })
                    }
                  >
                    {ic.plus}Add network card
                  </button>
                </div>
                <span className="note">A fixed IPv4 works on Incus bridge networks. To put an instance on your own LAN, pick a host interface.</span>
              </div>
            </div>
            <div className="hrow">
              <div className="hl">
                <b title="devices.*.type: proxy">Port forwarding</b>
              </div>
              <ProxyEditor devices={draft.devices} inherited={inh("proxy")} edit={edit} server={server} errors={devErrs} />
            </div>
          </section>

          <section className="hsec">
            <header>
              <h2>Profiles</h2>
            </header>
            <div className="hrow">
              <div className="hl">
                <b title="profiles">Profiles{original.profiles.join() !== draft.profiles.join() && <span className="chg" />}</b>
              </div>
              <div className="hc devl">
                {draft.profiles.map((p, i) => (
                  <div className="dev pf" key={p}>
                    <span className="idx">{i + 1}</span>
                    <span className="mono">{p}</span>
                    <button className="btn btn-q ib btn-sm" aria-label={`Move ${p} up`} disabled={i === 0} onClick={() => upd((x) => void x.profiles.splice(i - 1, 2, x.profiles[i], x.profiles[i - 1]))}>
                      <span style={{ display: "inline-flex", transform: "rotate(180deg)" }}>{ic.down}</span>
                    </button>
                    <button className="btn btn-q ib btn-sm" aria-label={`Move ${p} down`} disabled={i === draft.profiles.length - 1} onClick={() => upd((x) => void x.profiles.splice(i, 2, x.profiles[i + 1], x.profiles[i]))}>
                      {ic.down}
                    </button>
                    <button className="btn btn-q ib btn-sm" aria-label={"Remove profile " + p} onClick={() => upd((x) => void x.profiles.splice(i, 1))}>
                      {ic.x}
                    </button>
                  </div>
                ))}
                {draft.profiles.length === 0 && <span className="note">No profiles. This instance only uses its own settings.</span>}
                {allProfiles.some((p) => !draft.profiles.includes(p)) && (
                  <div className="field" style={{ width: 220 }}>
                    <select aria-label="Add profile" value="" onChange={(e) => e.target.value && upd((x) => void x.profiles.push(e.target.value))}>
                      <option value="">Add a profile…</option>
                      {allProfiles
                        .filter((p) => !draft.profiles.includes(p))
                        .map((p) => (
                          <option key={p}>{p}</option>
                        ))}
                    </select>
                  </div>
                )}
                <span className="note">Applied in order. Later profiles win.</span>
              </div>
            </div>
          </section>

          <section className="hsec">
            <header>
              <h2>Boot and snapshots</h2>
            </header>
            <div className="hrow">
              <div className="hl">
                <b title="boot.autostart">Start with server{(changed("boot.autostart") || changed("boot.autostart.priority")) && <span className="chg" />}</b>
                {from("boot.autostart") && <span className="from">{from("boot.autostart")}</span>}
              </div>
              <div className="hc">
                <div className="line">
                  <Toggle on={autostart} onChange={(v) => setCfg("boot.autostart", v ? "true" : "false")} label="Start with server" />
                  <span className="dim">Order</span>
                  <div className="step">
                    <button type="button" aria-label="Earlier" onClick={() => setCfg("boot.autostart.priority", String(Math.max(0, Number(eff("boot.autostart.priority") || 0) - 1)))}>
                      −
                    </button>
                    <input aria-label="Start order" value={val("boot.autostart.priority") || "0"} onChange={(e) => setCfg("boot.autostart.priority", e.target.value.replace(/\D/g, ""))} />
                    <button type="button" aria-label="Later" onClick={() => setCfg("boot.autostart.priority", String(Number(eff("boot.autostart.priority") || 0) + 1))}>
                      +
                    </button>
                  </div>
                  <span className="note">Higher starts first.</span>
                </div>
              </div>
            </div>
            <div className="hrow">
              <div className="hl">
                <b title="snapshots.schedule, snapshots.expiry">Snapshots{(changed("snapshots.schedule") || changed("snapshots.expiry")) && <span className="chg" />}</b>
                {from("snapshots.schedule") && <span className="from">{from("snapshots.schedule")}</span>}
              </div>
              <div className="hc">
                <div className="line">
                  <div className="field">
                    <select aria-label="Snapshot schedule" value={schedV} onChange={(e) => setCfg("snapshots.schedule", e.target.value)}>
                      {sched.map((s) => (
                        <option key={s.v} value={s.v}>
                          {s.l}
                        </option>
                      ))}
                      {schedV && !sched.some((s) => s.v === schedV) && <option>{schedV}</option>}
                    </select>
                  </div>
                  <span className="dim">kept for</span>
                  <div className="field">
                    <select aria-label="Snapshot expiry" value={eff("snapshots.expiry")} onChange={(e) => setCfg("snapshots.expiry", e.target.value)}>
                      {expiry.map((s) => (
                        <option key={s} value={s}>
                          {s || "forever"}
                        </option>
                      ))}
                      {eff("snapshots.expiry") && !expiry.includes(eff("snapshots.expiry")) && <option>{eff("snapshots.expiry")}</option>}
                    </select>
                  </div>
                  {useProfile("snapshots.schedule")}
                </div>
                {onlyProfile("snapshots.schedule") && <span className="note">Profile {prof.cfgFrom["snapshots.schedule"]} sets this. Pick another schedule to override it here.</span>}
              </div>
            </div>
            {!isVM && (
              <div className="hrow">
                <div className="hl">
                  <b title="security.nesting">Nesting{changed("security.nesting") && <span className="chg" />}</b>
                  {from("security.nesting") && <span className="from">{from("security.nesting")}</span>}
                </div>
                <div className="hc">
                  <div className="line">
                    <Toggle on={nesting} onChange={(v) => setCfg("security.nesting", v ? "true" : "false")} label="Nesting" />
                    <span className="note">Needed to run Docker or Incus inside this container.</span>
                    {useProfile("security.nesting")}
                  </div>
                </div>
              </div>
            )}
            <div className="hrow">
              <div className="hl">
                <b>Description</b>
              </div>
              <div className="hc">
                <div className="field">
                  <input aria-label="Description" value={draft.description} onChange={(e) => upd((d) => void (d.description = e.target.value))} placeholder="What runs here" />
                </div>
              </div>
            </div>
          </section>
        </>
      )}
      {hwbar.mounted && (
        <div className={"hwbar" + (hwbar.leaving ? " leaving" : "")}>
          <b>{view === "yaml" ? "Edited" : `${nChanges} change${nChanges === 1 ? "" : "s"}`}</b>
          <span className="dim">not applied yet</span>
          <button
            className="btn btn-q btn-sm"
            onClick={() => {
              setDraft(original);
              setDirty(false);
              setTried(false);
              setYamlText(origY);
            }}
          >
            Discard
          </button>
          <button className="btn btn-p btn-sm press" onClick={startReview}>
            Review and apply
          </button>
        </div>
      )}
      <Dialog open={review} onClose={() => !busy && setReview(false)} size="md">
        <div className="dlg-b">
          <h2>Review changes to {name}</h2>
          {Object.keys(warns).length > 0 && (
            <ul className="wlist">
              {Object.values(warns).map((w) => (
                <li key={w}>{w} It is allowed, but check it is what you want.</li>
              ))}
            </ul>
          )}
          <div className="diff">
            {diffLines(origY, YAML.stringify(cd))
              .filter((l, i, arr) => l.t !== "c" || arr.slice(Math.max(0, i - 2), i + 3).some((x) => x.t !== "c"))
              .map((l, i) => (
                <div key={i} className={l.t}>
                  {l.t === "c" ? "  " + l.s : l.s}
                </div>
              ))}
          </div>
          {applyErr && (
            <div className="cerr" role="alert">
              {applyErr}
            </div>
          )}
        </div>
        <div className="dlg-f">
          <button className="btn btn-s press" disabled={busy} onClick={() => setReview(false)}>
            Keep editing
          </button>
          <button className="btn btn-p press" disabled={busy} onClick={apply}>
            {busy ? "Applying…" : applyErr ? "Try again" : "Apply"}
          </button>
        </div>
      </Dialog>
    </div>
  );
}
