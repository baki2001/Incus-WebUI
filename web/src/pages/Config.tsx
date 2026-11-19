import { useEffect, useMemo, useState } from "react";
import YAML from "yaml";
import { incus, incusOp, parseBytes, type Instance } from "../api";
import { ic } from "../icons";
import { invalidate, useApp, useData } from "../state";
import { Dialog, Seg } from "../ui";

type Inst = Instance & { server: string };
type Put = { description: string; profiles: string[]; config: Record<string, string>; devices: Record<string, Record<string, string>> };

function toPut(i: Inst): Put {
  const config: Record<string, string> = {};
  for (const [k, v] of Object.entries(i.config || {})) if (!k.startsWith("volatile.") && !k.startsWith("image.")) config[k] = v;
  return { description: i.description || "", profiles: [...i.profiles], config, devices: JSON.parse(JSON.stringify(i.devices || {})) };
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

export function ConfigTab({ inst, reload }: { inst: Inst; reload: () => void }) {
  const app = useApp();
  const original = useMemo(() => toPut(inst), [inst]);
  const [draft, setDraft] = useState<Put>(original);
  const [dirty, setDirty] = useState(false);
  const [view, setView] = useState<"form" | "yaml">("form");
  const [yamlText, setYamlText] = useState("");
  const [yamlErr, setYamlErr] = useState("");
  const [review, setReview] = useState(false);
  const host = useData<any>(`resources:${inst.server}`, () => incus(inst.server, "/1.0/resources"));
  const pools = useData<string[]>(`pools:${inst.server}:${inst.project}`, async () => (await incus<string[]>(inst.server, "/1.0/storage-pools", { project: inst.project })).map((p) => p.split("/").pop()!));
  const nets = useData<string[]>(`nets:${inst.server}:${inst.project}`, async () => (await incus<string[]>(inst.server, "/1.0/networks", { project: inst.project })).map((p) => decodeURIComponent(p.split("/").pop()!)));

  // keep in sync with the server while nothing is edited
  useEffect(() => {
    if (!dirty) setDraft(original);
  }, [original, dirty]);

  const upd = (fn: (d: Put) => void) => {
    const next: Put = JSON.parse(JSON.stringify(draft));
    fn(next);
    setDraft(next);
    setDirty(true);
  };
  const setCfg = (k: string, v: string) =>
    upd((d) => {
      if (v === "") delete d.config[k];
      else d.config[k] = v;
    });
  const ex = inst.expanded_config || {};
  const from = (k: string) => (k in draft.config ? "Set on this instance" : ex[k] ? "From a profile" : "Not set");
  const changed = (k: string) => (draft.config[k] ?? "") !== (original.config[k] ?? "");

  const origY = useMemo(() => YAML.stringify(original), [original]);
    const nChanges = useMemo(() => {
    const keys = (a: Record<string, unknown>, b: Record<string, unknown>) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).length;
    return keys(original.config, draft.config) + keys(original.devices, draft.devices) + (original.description !== draft.description ? 1 : 0) + (original.profiles.join() !== draft.profiles.join() ? 1 : 0);
  }, [original, draft]);

  const switchView = (v: "form" | "yaml") => {
    if (v === "yaml") {
      setYamlText(YAML.stringify(draft));
      setYamlErr("");
    } else if (view === "yaml") {
      try {
        const p = YAML.parse(yamlText) as Put;
        setDraft({ description: p.description || "", profiles: p.profiles || [], config: p.config || {}, devices: p.devices || {} });
        setDirty(true);
      } catch (e: any) {
        setYamlErr(e.message);
        return;
      }
    }
    setView(v);
  };
  const startReview = () => {
    if (view === "yaml") {
      try {
        const p = YAML.parse(yamlText) as Put;
        setDraft({ description: p.description || "", profiles: p.profiles || [], config: p.config || {}, devices: p.devices || {} });
        setYamlErr("");
      } catch (e: any) {
        setYamlErr(e.message);
        return;
      }
    }
    setReview(true);
  };
  const apply = async () => {
    setReview(false);
    const body = { ...draft, architecture: inst.architecture, ephemeral: inst.ephemeral, stateful: inst.stateful };
    // keep volatile keys Incus manages
    for (const [k, v] of Object.entries(inst.config)) if (k.startsWith("volatile.") || k.startsWith("image.")) body.config[k] = v;
    const ok = await app.run(
      `Applying changes to ${inst.name}`,
      async () => {
        await incusOp(inst.server, `/1.0/instances/${encodeURIComponent(inst.name)}`, { method: "PUT", project: inst.project, body });
        return true;
      },
      "Changes applied",
    );
    if (ok) {
      setDirty(false);
      invalidate("instances:");
      reload();
    }
  };

  const cores = host.data?.cpu?.total;
  const hostMem = host.data?.memory?.total;
  const cpu = draft.config["limits.cpu"] ?? "";
  const memBytes = parseBytes(draft.config["limits.memory"] ?? ex["limits.memory"]);
  const memGiB = memBytes ? Math.round((memBytes / 1024 ** 3) * 10) / 10 : "";
  const hard = (draft.config["limits.memory.enforce"] ?? ex["limits.memory.enforce"] ?? "hard") === "hard";
  const rootLocal = draft.devices.root;
  const rootEff = rootLocal || inst.expanded_devices?.root || {};
  const rootGiB = parseBytes(rootEff.size) ? Math.round(parseBytes(rootEff.size)! / 1024 ** 3) : "";
  const isVM = inst.type === "virtual-machine";
  const disks = Object.entries(draft.devices).filter(([n, d]) => d.type === "disk" && n !== "root");
  const nics = Object.entries(draft.devices).filter(([, d]) => d.type === "nic");
  const profNics = Object.entries(inst.expanded_devices || {}).filter(([n, d]) => d.type === "nic" && !draft.devices[n]);
  const autostart = (draft.config["boot.autostart"] ?? ex["boot.autostart"] ?? "false") === "true";

  return (
    <div className="hw">
      <div className="cfg-h">
        <span className="dim">Settings for {inst.name}. Values that come from a profile say so.</span>
        <Seg value={view} onChange={switchView} options={[{ v: "form", l: "Form" }, { v: "yaml", l: <span className="ac">YAML</span> }]} />
      </div>
      {view === "yaml" ? (
        <div className="panel">
          <textarea className="yaml" spellCheck={false} value={yamlText} onChange={(e) => (setYamlText(e.target.value), setDirty(true))} />
          {yamlErr && <div className="pfoot bad">{yamlErr}</div>}
        </div>
      ) : (
        <>
          <section className="hsec">
            <header>
              <h2>Compute</h2>
              {host.data && (
                <p>
                  {inst.server} · {host.data.cpu?.sockets?.[0]?.name || ""} {cores ? `· ${cores} threads` : ""} {hostMem ? `· ${Math.round(hostMem / 1024 ** 3)} GiB` : ""}
                </p>
              )}
            </header>
            <div className="hrow">
              <div className="hl">
                <b>CPU{changed("limits.cpu") && <span className="chg" />}</b>
                <code>limits.cpu</code>
                <span className="from">{from("limits.cpu")}</span>
              </div>
              <div className="hc">
                <div className="line">
                  <div className="step">
                    <button type="button" aria-label="Fewer" onClick={() => setCfg("limits.cpu", String(Math.max(1, (Number(cpu) || Number(ex["limits.cpu"]) || 1) - 1)))}>
                      −
                    </button>
                    <input value={cpu} placeholder={ex["limits.cpu"] || "all"} onChange={(e) => setCfg("limits.cpu", e.target.value.replace(/[^\d,-]/g, ""))} />
                    <button type="button" aria-label="More" onClick={() => setCfg("limits.cpu", String(Math.min(cores || 512, (Number(cpu) || Number(ex["limits.cpu"]) || 0) + 1)))}>
                      +
                    </button>
                  </div>
                  {cores && <span className="dim">of {cores}</span>}
                  {cpu && (
                    <button className="btn btn-q btn-sm" onClick={() => setCfg("limits.cpu", "")}>
                      No limit
                    </button>
                  )}
                </div>
                <span className="note">{isVM ? "Applies on the next restart for VMs." : "Applies right away, no restart."} Empty means all cores.</span>
              </div>
            </div>
            <div className="hrow">
              <div className="hl">
                <b>Memory{(changed("limits.memory") || changed("limits.memory.enforce")) && <span className="chg" />}</b>
                <code>limits.memory, .enforce</code>
                <span className="from">{from("limits.memory")}</span>
              </div>
              <div className="hc">
                <div className="line">
                  {hostMem && (
                    <input type="range" min={0.25} max={Math.floor(hostMem / 1024 ** 3)} step={0.25} value={memGiB || 0} onChange={(e) => setCfg("limits.memory", e.target.value + "GiB")} />
                  )}
                  <div className="unit">
                    <div className="field">
                      <input value={memGiB} placeholder="no limit" onChange={(e) => setCfg("limits.memory", e.target.value ? e.target.value.replace(/[^\d.]/g, "") + "GiB" : "")} />
                    </div>
                    GiB
                  </div>
                </div>
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
            <div className="hrow">
              <div className="hl">
                <b>Root disk{JSON.stringify(draft.devices.root) !== JSON.stringify(original.devices.root) && <span className="chg" />}</b>
                <code>devices.root.size</code>
                <span className="from">{rootLocal ? "Set on this instance" : "From a profile"}</span>
              </div>
              <div className="hc">
                <div className="line">
                  <div className="unit">
                    <div className="field">
                      <input
                        value={rootGiB}
                        placeholder="pool default"
                        onChange={(e) =>
                          upd((d) => {
                            const base = d.devices.root || { ...(inst.expanded_devices?.root || { type: "disk", path: "/", pool: pools.data?.[0] || "default" }) };
                            const v = e.target.value.replace(/\D/g, "");
                            if (v) base.size = v + "GiB";
                            else delete base.size;
                            d.devices.root = base;
                          })
                        }
                      />
                    </div>
                    GiB on pool <span className="tag mono">{rootEff.pool || "–"}</span>
                  </div>
                </div>
                <span className="note">Disks can grow, not shrink.</span>
              </div>
            </div>
            <div className="hrow">
              <div className="hl">
                <b>Extra disks</b>
                <code>devices.*.type: disk</code>
              </div>
              <div className="hc devl">
                {disks.length > 0 && (
                  <div className="dev">
                    <span className="hdr">Name</span>
                    <span className="hdr">Host path or volume</span>
                    <span className="hdr">Path inside</span>
                    <span />
                    <span />
                  </div>
                )}
                {disks.map(([n, d]) => (
                  <div className="dev" key={n}>
                    <div className="field mono-in">
                      <input value={n} readOnly />
                    </div>
                    <div className="field mono-in">
                      <input value={d.source || ""} onChange={(e) => upd((x) => void (x.devices[n].source = e.target.value))} placeholder="/srv/data" />
                    </div>
                    <div className="field mono-in">
                      <input value={d.path || ""} onChange={(e) => upd((x) => void (x.devices[n].path = e.target.value))} placeholder="/mnt/data" />
                    </div>
                    <span className="dim mono" style={{ fontSize: 12 }}>
                      {d.pool || ""}
                    </span>
                    <button className="btn btn-q ib btn-sm" aria-label={"Remove " + n} onClick={() => upd((x) => void delete x.devices[n])}>
                      {ic.x}
                    </button>
                  </div>
                ))}
                <div>
                  <button
                    className="btn btn-s btn-sm press"
                    onClick={() =>
                      upd((x) => {
                        let i = 1;
                        while (x.devices["disk" + i]) i++;
                        x.devices["disk" + i] = { type: "disk", source: "", path: "" };
                      })
                    }
                  >
                    {ic.plus}Add disk
                  </button>
                </div>
              </div>
            </div>
          </section>

          <section className="hsec">
            <header>
              <h2>Network</h2>
            </header>
            <div className="hrow">
              <div className="hl">
                <b>Network cards</b>
                <code>devices.*.type: nic</code>
                {profNics.length > 0 && <span className="from">{profNics.map(([n]) => n).join(", ")} from profile</span>}
              </div>
              <div className="hc devl">
                {[...profNics.map(([n, d]) => [n, d, true] as const), ...nics.map(([n, d]) => [n, d, false] as const)].map(([n, d, inherited]) => (
                  <div className="dev n" key={n}>
                    <div className="field mono-in">
                      <input value={n} readOnly />
                    </div>
                    <div className="field">
                      <select
                        value={d.network || ""}
                        disabled={inherited}
                        onChange={(e) =>
                          upd((x) => {
                            x.devices[n] = { type: "nic", network: e.target.value, name: d.name || n };
                          })
                        }
                      >
                        {!d.network && <option value="">{d.parent ? `${d.nictype} on ${d.parent}` : "–"}</option>}
                        {(nets.data || []).map((nn) => (
                          <option key={nn}>{nn}</option>
                        ))}
                      </select>
                    </div>
                    <div className="field mono-in">
                      <input
                        value={d["ipv4.address"] || ""}
                        placeholder="Automatic (DHCP)"
                        disabled={inherited}
                        onChange={(e) =>
                          upd((x) => {
                            if (e.target.value) x.devices[n]["ipv4.address"] = e.target.value;
                            else delete x.devices[n]["ipv4.address"];
                          })
                        }
                      />
                    </div>
                    {inherited ? (
                      <button className="btn btn-q btn-sm" title="Copy to this instance to edit" onClick={() => upd((x) => void (x.devices[n] = { ...d }))}>
                        Edit
                      </button>
                    ) : (
                      <button className="btn btn-q ib btn-sm" aria-label={"Remove " + n} onClick={() => upd((x) => void delete x.devices[n])}>
                        {ic.x}
                      </button>
                    )}
                  </div>
                ))}
                <div>
                  <button
                    className="btn btn-s btn-sm press"
                    onClick={() =>
                      upd((x) => {
                        let i = 0;
                        while (x.devices["eth" + i] || inst.expanded_devices?.["eth" + i]) i++;
                        x.devices["eth" + i] = { type: "nic", network: nets.data?.[0] || "incusbr0", name: "eth" + i };
                      })
                    }
                  >
                    {ic.plus}Add network card
                  </button>
                </div>
                <span className="note">A fixed IPv4 needs a managed bridge network.</span>
              </div>
            </div>
          </section>

          <section className="hsec">
            <header>
              <h2>Boot and snapshots</h2>
            </header>
            <div className="hrow">
              <div className="hl">
                <b>Start with server{(changed("boot.autostart") || changed("boot.autostart.priority")) && <span className="chg" />}</b>
                <code>boot.autostart</code>
                <span className="from">{from("boot.autostart")}</span>
              </div>
              <div className="hc">
                <div className="line">
                  <button className="toggle" role="switch" aria-checked={autostart} aria-label="Start with server" onClick={() => setCfg("boot.autostart", autostart ? "false" : "true")} />
                  <span className="dim">Order</span>
                  <div className="step">
                    <button type="button" onClick={() => setCfg("boot.autostart.priority", String(Math.max(0, Number(draft.config["boot.autostart.priority"] || 0) - 1)))}>
                      −
                    </button>
                    <input value={draft.config["boot.autostart.priority"] || "0"} onChange={(e) => setCfg("boot.autostart.priority", e.target.value.replace(/\D/g, ""))} />
                    <button type="button" onClick={() => setCfg("boot.autostart.priority", String(Number(draft.config["boot.autostart.priority"] || 0) + 1))}>
                      +
                    </button>
                  </div>
                  <span className="note">Higher starts first.</span>
                </div>
              </div>
            </div>
            <div className="hrow">
              <div className="hl">
                <b>Snapshots{(changed("snapshots.schedule") || changed("snapshots.expiry")) && <span className="chg" />}</b>
                <code>snapshots.schedule, .expiry</code>
                <span className="from">{from("snapshots.schedule")}</span>
              </div>
              <div className="hc">
                <div className="line">
                  <div className="field">
                    <select value={draft.config["snapshots.schedule"] ?? ""} onChange={(e) => setCfg("snapshots.schedule", e.target.value)}>
                      {sched.map((s) => (
                        <option key={s.v} value={s.v}>
                          {s.l}
                        </option>
                      ))}
                      {draft.config["snapshots.schedule"] && !sched.some((s) => s.v === draft.config["snapshots.schedule"]) && <option>{draft.config["snapshots.schedule"]}</option>}
                    </select>
                  </div>
                  <span className="dim">kept for</span>
                  <div className="field">
                    <select value={draft.config["snapshots.expiry"] ?? ""} onChange={(e) => setCfg("snapshots.expiry", e.target.value)}>
                      {expiry.map((s) => (
                        <option key={s} value={s}>
                          {s || "forever"}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            </div>
            {!isVM && (
              <div className="hrow">
                <div className="hl">
                  <b>Nesting{changed("security.nesting") && <span className="chg" />}</b>
                  <code>security.nesting</code>
                  <span className="from">{from("security.nesting")}</span>
                </div>
                <div className="hc">
                  <div className="line">
                    <button
                      className="toggle"
                      role="switch"
                      aria-label="Nesting"
                      aria-checked={(draft.config["security.nesting"] ?? ex["security.nesting"]) === "true"}
                      onClick={() => setCfg("security.nesting", (draft.config["security.nesting"] ?? ex["security.nesting"]) === "true" ? "false" : "true")}
                    />
                    <span className="note">Needed to run Docker or Incus inside this container.</span>
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
                  <input value={draft.description} onChange={(e) => upd((d) => void (d.description = e.target.value))} placeholder="What runs here" />
                </div>
              </div>
            </div>
          </section>
        </>
      )}
      {dirty && (nChanges > 0 || view === "yaml") && (
        <div className="hwbar">
          <b>{view === "yaml" ? "Edited" : `${nChanges} change${nChanges === 1 ? "" : "s"}`}</b>
          <span className="dim">not applied yet</span>
          <button
            className="btn btn-q btn-sm"
            onClick={() => {
              setDraft(original);
              setDirty(false);
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
      <Dialog open={review} onClose={() => setReview(false)} size="md">
        <div className="dlg-b">
          <h2>Review changes to {inst.name}</h2>
          <div className="diff">
            {diffLines(origY, YAML.stringify(draft))
              .filter((l, i, arr) => l.t !== "c" || arr.slice(Math.max(0, i - 2), i + 3).some((x) => x.t !== "c"))
              .map((l, i) => (
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
          <button className="btn btn-p press" onClick={apply}>
            Apply
          </button>
        </div>
      </Dialog>
    </div>
  );
}
