import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { incus, incusRaw, wsURL, type Instance } from "../api";
import { ic } from "../icons";

type Inst = Instance & { server: string };
type Conn = { state: "connecting" | "open" | "closed" | "error"; msg?: string };

function cssVar(n: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(n).trim();
}

function makeTerm(el: HTMLElement) {
  const term = new Terminal({
    fontFamily: '"Geist Mono Variable","Geist Mono",ui-monospace,Menlo,Consolas,monospace',
    fontSize: 13,
    lineHeight: 1.25,
    cursorBlink: true,
    allowProposedApi: false,
    scrollback: 5000,
    theme: {
      background: cssVar("--s1") || "#161618",
      foreground: cssVar("--ink") || "#eee",
      cursor: cssVar("--ink"),
      selectionBackground: cssVar("--accent-soft") || "rgba(120,140,220,.3)",
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el);
  try {
    fit.fit();
  } catch {
    /* not visible yet */
  }
  return { term, fit };
}

// Connects an xterm to an Incus operation that exposes "0" (data) and "control" websockets.
function attach(term: Terminal, fit: FitAddon, server: string, project: string, op: any, setConn: (c: Conn) => void) {
  const fds = op.metadata?.fds || {};
  const control = new WebSocket(wsURL(server, op.id, fds.control, project));
  const data = new WebSocket(wsURL(server, op.id, fds["0"], project));
  data.binaryType = "arraybuffer";
  const enc = new TextEncoder();
  const resize = () => {
    try {
      fit.fit();
    } catch {
      return;
    }
    if (control.readyState === WebSocket.OPEN) control.send(JSON.stringify({ command: "window-resize", args: { width: String(term.cols), height: String(term.rows) } }));
  };
  data.onopen = () => {
    setConn({ state: "open" });
    resize();
    term.focus();
  };
  data.onmessage = (e) => term.write(typeof e.data === "string" ? e.data : new Uint8Array(e.data));
  data.onclose = () => setConn({ state: "closed" });
  data.onerror = () => setConn({ state: "error", msg: "The connection dropped." });
  control.onopen = resize;
  const d1 = term.onData((d) => data.readyState === WebSocket.OPEN && data.send(enc.encode(d)));
  const d2 = term.onBinary((d) => data.readyState === WebSocket.OPEN && data.send(Uint8Array.from(d, (c) => c.charCodeAt(0))));
  const ro = new ResizeObserver(() => resize());
  ro.observe(term.element!.parentElement!);
  return () => {
    ro.disconnect();
    d1.dispose();
    d2.dispose();
    data.onclose = null;
    data.close();
    control.close();
  };
}

function NotRunning({ inst, onStart, what }: { inst: Inst; onStart: () => void; what: string }) {
  return (
    <div className="panel" style={{ padding: 24, display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
      <div>
        <b>{inst.name} is not running.</b>
        <div className="dim">{what}</div>
      </div>
      <button className="btn btn-p press" onClick={onStart} style={{ marginLeft: "auto" }}>
        {ic.play}Start
      </button>
    </div>
  );
}

// ---------- Terminal: a new shell inside the instance (incus exec) ----------

const SHELL = ["sh", "-c", "if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh -l; fi"];

export function TerminalTab({ inst, onStart }: { inst: Inst; onStart: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [conn, setConn] = useState<Conn>({ state: "connecting" });
  const [gen, setGen] = useState(0);
  const [size, setSize] = useState("");
  const termRef = useRef<Terminal | null>(null);
  const running = inst.status === "Running";
  const started = useRef(new Date());

  useEffect(() => {
    if (!running || !box.current) return;
    const { term, fit } = makeTerm(box.current);
    termRef.current = term;
    term.onResize(({ cols, rows }) => setSize(`${cols} × ${rows}`));
    setSize(`${term.cols} × ${term.rows}`);
    started.current = new Date();
    let detach = () => {};
    let dead = false;
    setConn({ state: "connecting" });
    incus(inst.server, `/1.0/instances/${encodeURIComponent(inst.name)}/exec`, {
      project: inst.project,
      method: "POST",
      body: { command: SHELL, interactive: true, "wait-for-websocket": true, environment: { TERM: "xterm-256color", HOME: "/root", USER: "root", LANG: "C.UTF-8" }, width: term.cols, height: term.rows },
    })
      .then((op) => {
        if (!dead) detach = attach(term, fit, inst.server, inst.project, op, setConn);
      })
      .catch((e) => {
        setConn({ state: "error", msg: e.message });
      });
    return () => {
      dead = true;
      detach();
      term.dispose();
    };
  }, [inst.server, inst.name, inst.project, running, gen]);

  if (!running) return <NotRunning inst={inst} onStart={onStart} what="The terminal opens a shell inside a running instance." />;
  const isMac = navigator.platform.includes("Mac");
  return (
    <div className="term">
      <div className="term-h">
        <span className="on" data-s={conn.state} />
        <span>
          <b>shell</b> · root@{inst.name}
        </span>
        {conn.state !== "open" && <span className="dim">{conn.state === "connecting" ? "connecting…" : conn.msg || "session ended"}</span>}
        <span className="r">
          <button className="btn btn-q btn-sm" onClick={() => termRef.current?.clear()}>
            Clear
          </button>
          <button className="btn btn-q btn-sm" onClick={() => setGen((g) => g + 1)}>
            Reconnect
          </button>
        </span>
      </div>
      <div className="xterm-box" ref={box} />
      <div className="term-f">
        <span>Started {started.current.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</span>
        <span>{size}</span>
        <span>UTF-8</span>
        <span>{isMac ? "Copy with ⌘C, paste with ⌘V" : "Copy with Ctrl+Shift+C, paste with Ctrl+Shift+V"}</span>
      </div>
    </div>
  );
}

// ---------- Console: the instance's own screen ----------

export function ConsoleTab({ inst, onStart }: { inst: Inst; onStart: () => void }) {
  const isVM = inst.type === "virtual-machine";
  const [mode, setMode] = useState<"vga" | "text">(isVM ? "vga" : "text");
  return (
    <div className="col">
      <div className="radios" role="radiogroup" aria-label="Console type">
        {isVM && (
          <label>
            <input type="radio" name="cmode" checked={mode === "vga"} onChange={() => setMode("vga")} />
            Graphic
          </label>
        )}
        <label>
          <input type="radio" name="cmode" checked={mode === "text"} onChange={() => setMode("text")} />
          Text console
        </label>
        <span className="dim" style={{ fontSize: 12.5 }}>
          {mode === "vga" ? "The VM's screen, like a monitor plugged into it." : "The boot and login console. Works even when the network inside is down."}
        </span>
      </div>
      {inst.status !== "Running" ? (
        <NotRunning inst={inst} onStart={onStart} what="Start it to see its console. Boot messages show up here from the first second." />
      ) : mode === "vga" ? (
        <GraphicConsole inst={inst} />
      ) : (
        <TextConsole inst={inst} />
      )}
    </div>
  );
}

function TextConsole({ inst }: { inst: Inst }) {
  const box = useRef<HTMLDivElement>(null);
  const [conn, setConn] = useState<Conn>({ state: "connecting" });
  const [gen, setGen] = useState(0);
  useEffect(() => {
    if (!box.current) return;
    const { term, fit } = makeTerm(box.current);
    let detach = () => {};
    let dead = false;
    setConn({ state: "connecting" });
    (async () => {
      // replay what the console printed so far (containers keep a buffer)
      if (inst.type === "container") {
        const r = await incusRaw(inst.server, `/1.0/instances/${encodeURIComponent(inst.name)}/console`, { project: inst.project }).catch(() => null);
        if (r?.ok) term.write(new Uint8Array(await r.arrayBuffer()));
      }
      const op = await incus(inst.server, `/1.0/instances/${encodeURIComponent(inst.name)}/console`, {
        project: inst.project,
        method: "POST",
        body: { type: "console", width: term.cols, height: term.rows },
      });
      if (!dead) detach = attach(term, fit, inst.server, inst.project, op, setConn);
      term.write("\r\n");
    })().catch((e) => setConn({ state: "error", msg: e.message }));
    return () => {
      dead = true;
      detach();
      term.dispose();
    };
  }, [inst.server, inst.name, inst.project, inst.type, gen]);
  return (
    <div className="term">
      <div className="term-h">
        <span className="on" data-s={conn.state} />
        <span>
          <b>console</b> · {inst.name}
        </span>
        {conn.state !== "open" && <span className="dim">{conn.state === "connecting" ? "connecting…" : conn.msg || "disconnected"}</span>}
        <span className="r">
          <button className="btn btn-q btn-sm" onClick={() => setGen((g) => g + 1)}>
            Reconnect
          </button>
        </span>
      </div>
      <div className="xterm-box" ref={box} />
      <div className="term-f">
        <span>Press Enter if the screen stays empty. Only one console session can be open at a time.</span>
      </div>
    </div>
  );
}

function GraphicConsole({ inst }: { inst: Inst }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [conn, setConn] = useState<Conn>({ state: "connecting" });
  const [gen, setGen] = useState(0);
  const spiceRef = useRef<any>(null);
  const screenId = "spice-screen";

  useEffect(() => {
    let dead = false;
    let control: WebSocket | null = null;
    setConn({ state: "connecting" });
    (async () => {
      const spice = await import("@spice-project/spice-html5");
      const op = await incus(inst.server, `/1.0/instances/${encodeURIComponent(inst.name)}/console`, {
        project: inst.project,
        method: "POST",
        body: { type: "vga", width: 0, height: 0 },
      });
      if (dead) return;
      const fds = op.metadata?.fds || {};
      control = new WebSocket(wsURL(inst.server, op.id, fds.control, inst.project));
      const sc = new spice.SpiceMainConn({
        uri: wsURL(inst.server, op.id, fds["0"], inst.project),
        password: "",
        screen_id: screenId,
        onerror: (e: any) => !dead && setConn({ state: "error", msg: String(e?.message || e || "SPICE error") }),
        onsuccess: () => !dead && setConn({ state: "open" }),
        onagent: () => spice.resize_helper(sc),
      });
      const onResize = () => spice.resize_helper(sc);
      window.addEventListener("resize", onResize);
      spiceRef.current = { sc, spice, onResize };
    })().catch((e) => setConn({ state: "error", msg: e.message }));
    return () => {
      dead = true;
      if (spiceRef.current?.onResize) window.removeEventListener("resize", spiceRef.current.onResize);
      try {
        spiceRef.current?.sc.stop();
      } catch {
        /* ignore */
      }
      spiceRef.current = null;
      control?.close();
      const s = document.getElementById(screenId);
      if (s) s.innerHTML = "";
    };
  }, [inst.server, inst.name, inst.project, gen]);

  return (
    <div className="term" ref={wrap}>
      <div className="term-h">
        <span className="on" data-s={conn.state} />
        <span>
          <b>screen</b> · {inst.name}
        </span>
        {conn.state !== "open" && <span className="dim">{conn.state === "connecting" ? "connecting…" : conn.msg || "disconnected"}</span>}
        <span className="r">
          <button className="btn btn-q btn-sm" disabled={conn.state !== "open"} onClick={() => spiceRef.current && spiceRef.current.spice.sendCtrlAltDel(spiceRef.current.sc)}>
            {ic.kbd}Ctrl+Alt+Del
          </button>
          <button className="btn btn-q btn-sm" onClick={() => wrap.current?.requestFullscreen?.()}>
            {ic.full}Full screen
          </button>
          <button className="btn btn-q btn-sm" onClick={() => setGen((g) => g + 1)}>
            Reconnect
          </button>
        </span>
      </div>
      <div className="spice-box">
        <div id={screenId} className="spice-screen" tabIndex={0} />
      </div>
      <div className="term-f">
        <span>Click the screen to type into the VM. The mouse and keyboard go to the VM while it has focus.</span>
      </div>
    </div>
  );
}
