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
    lineHeight: 1.15,
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
  const refit = () => {
    try {
      fit.fit();
    } catch {
      /* not visible yet */
    }
  };
  refit();
  // The cell size changes once the web font has loaded.
  document.fonts?.ready.then(refit);
  // Ctrl+Shift+C copies (Ctrl+C too while text is selected); Ctrl+Shift+V and
  // Cmd+V paste through the browser. Without this, the browser's own shortcut
  // for Ctrl+Shift+C (developer tools) wins.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    const k = e.key.toLowerCase();
    if (e.ctrlKey && !e.altKey && k === "c" && (e.shiftKey || term.hasSelection())) {
      if (term.hasSelection()) navigator.clipboard?.writeText(term.getSelection()).catch(() => {});
      e.preventDefault();
      return false;
    }
    if (e.ctrlKey && e.shiftKey && k === "v") return false; // let the paste event through
    return true;
  });
  return { term, fit };
}

// Connects an xterm to an Incus operation that exposes "0" (data) and "control" websockets.
// `ctrl` is the sticky Ctrl of the phone key row: the next typed letter becomes a control character.
function attach(term: Terminal, fit: FitAddon, server: string, project: string, op: any, setConn: (c: Conn) => void, ctrl?: { current: boolean; onUse?: () => void }) {
  const fds = op.metadata?.fds || {};
  const control = new WebSocket(wsURL(server, op.id, fds.control, project));
  const data = new WebSocket(wsURL(server, op.id, fds["0"], project));
  data.binaryType = "arraybuffer";
  const enc = new TextEncoder();
  const send = (d: string) => data.readyState === WebSocket.OPEN && data.send(enc.encode(d));
  const resize = () => {
    // A hidden terminal (another tab is showing) has no size; keep the last one.
    if (!term.element?.parentElement?.offsetWidth) return;
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
  const d1 = term.onData((d) => {
    if (ctrl?.current && d.length === 1) {
      const c = d.toUpperCase().charCodeAt(0);
      if (c >= 64 && c <= 95) d = String.fromCharCode(c & 0x1f);
      ctrl.current = false;
      ctrl.onUse?.();
    }
    send(d);
  });
  const d2 = term.onBinary((d) => data.readyState === WebSocket.OPEN && data.send(Uint8Array.from(d, (c) => c.charCodeAt(0))));
  const ro = new ResizeObserver(() => resize());
  ro.observe(term.element!.parentElement!);
  // When the shell exits Incus closes the control socket but leaves the data one open.
  let gone = false;
  control.onclose = () =>
    setTimeout(() => {
      if (!gone && data.readyState === WebSocket.OPEN) data.close();
    }, 400);
  return {
    send,
    detach: () => {
      gone = true;
      ro.disconnect();
      d1.dispose();
      d2.dispose();
      data.onclose = null;
      data.close();
      control.close();
    },
  };
}

// Shown over a terminal whose shell has ended or never connected.
function Ended({ conn, onReconnect }: { conn: Conn; onReconnect: () => void }) {
  if (conn.state !== "closed" && conn.state !== "error") return null;
  return (
    <div className="term-end">
      <b>{conn.state === "closed" ? "Session ended" : "Can't connect"}</b>
      {conn.msg && <span className="dim">{conn.msg}</span>}
      <button className="btn btn-p press" onClick={onReconnect}>
        Reconnect
      </button>
    </div>
  );
}

function FullBtn({ target }: { target: React.RefObject<HTMLElement | null> }) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const f = () => setOn(document.fullscreenElement === target.current);
    document.addEventListener("fullscreenchange", f);
    return () => document.removeEventListener("fullscreenchange", f);
  }, [target]);
  return (
    <button className="btn btn-q btn-sm" onClick={() => (document.fullscreenElement ? document.exitFullscreen() : target.current?.requestFullscreen?.())}>
      {ic.full}
      {on ? "Exit full screen" : "Full screen"}
    </button>
  );
}

// Esc, Tab, sticky Ctrl, arrows and a few symbols that phone keyboards hide.
function KeyRow({ send, ctrl }: { send: (d: string) => void; ctrl: { current: boolean; onUse?: () => void } }) {
  const [on, setOn] = useState(false);
  ctrl.onUse = () => setOn(false);
  const keys: [string, string][] = [["Esc", "\x1b"], ["Tab", "\t"], ["↑", "\x1b[A"], ["↓", "\x1b[B"], ["←", "\x1b[D"], ["→", "\x1b[C"], ["|", "|"], ["~", "~"], ["/", "/"]];
  return (
    <div className="keyrow" onPointerDown={(e) => e.preventDefault()}>
      <button className={"btn btn-s" + (on ? " on" : "")} aria-pressed={on} onClick={() => setOn((ctrl.current = !ctrl.current))}>
        Ctrl
      </button>
      {keys.map(([l, v]) => (
        <button key={l} className="btn btn-s" onClick={() => send(v)} aria-label={l}>
          {l}
        </button>
      ))}
    </div>
  );
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

// Login shell: bash if there is one. For a non-root user HOME comes from passwd.
const SHELL = ["sh", "-c", 'h=$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6); [ -n "$h" ] && export HOME="$h"; if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh -l; fi'];

type Opts = { uid: string; cmd: string; cwd: string };

// The page keeps this mounted (hidden) while you visit other tabs, so the shell survives.
export function TerminalTab({ inst, onStart, visible = true }: { inst: Inst; onStart: () => void; visible?: boolean }) {
  const wrap = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [conn, setConn] = useState<Conn>({ state: "connecting" });
  const [gen, setGen] = useState(0);
  const [size, setSize] = useState("");
  const [showOpts, setShowOpts] = useState(false);
  const [opts, setOpts] = useState<Opts>({ uid: "", cmd: "", cwd: "" });
  const optsRef = useRef(opts);
  const termRef = useRef<Terminal | null>(null);
  const sendRef = useRef<(d: string) => void>(() => {});
  const ctrl = useRef<{ current: boolean; onUse?: () => void }>({ current: false }).current;
  const running = inst.status === "Running";
  const started = useRef(new Date());
  const uidBad = opts.uid !== "" && !/^\d+$/.test(opts.uid);

  useEffect(() => {
    if (!running || !box.current) return;
    const { term, fit } = makeTerm(box.current);
    termRef.current = term;
    term.onResize(({ cols, rows }) => setSize(`${cols} × ${rows}`));
    setSize(`${term.cols} × ${term.rows}`);
    started.current = new Date();
    ctrl.current = false;
    ctrl.onUse?.();
    let detach = () => {};
    let dead = false;
    setConn({ state: "connecting" });
    const o = optsRef.current;
    incus(inst.server, `/1.0/instances/${encodeURIComponent(inst.name)}/exec`, {
      project: inst.project,
      method: "POST",
      body: {
        command: o.cmd.trim() ? ["sh", "-c", o.cmd.trim()] : SHELL,
        interactive: true,
        "wait-for-websocket": true,
        environment: { TERM: "xterm-256color", LANG: "C.UTF-8" },
        ...(o.uid ? { user: Number(o.uid), group: Number(o.uid) } : {}),
        ...(o.cwd.trim() ? { cwd: o.cwd.trim() } : {}),
        width: term.cols,
        height: term.rows,
      },
    })
      .then((op) => {
        if (dead) return;
        const at = attach(term, fit, inst.server, inst.project, op, setConn, ctrl);
        detach = at.detach;
        sendRef.current = at.send;
      })
      .catch((e) => {
        setConn({ state: "error", msg: e.message });
      });
    return () => {
      dead = true;
      detach();
      sendRef.current = () => {};
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inst.server, inst.name, inst.project, running, gen]);

  // Back on this tab: refit and focus; the size observer ignores the hidden state.
  useEffect(() => {
    if (visible && conn.state === "open") termRef.current?.focus();
  }, [visible, conn.state]);

  // Phones: keep the terminal above the on-screen keyboard.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv || !visible) return;
    const f = () => document.documentElement.style.setProperty("--vvh", vv.height + "px");
    f();
    vv.addEventListener("resize", f);
    return () => {
      vv.removeEventListener("resize", f);
      document.documentElement.style.removeProperty("--vvh");
    };
  }, [visible]);

  if (!running) return <NotRunning inst={inst} onStart={onStart} what="The terminal opens a shell inside a running instance." />;
  const isMac = navigator.platform.includes("Mac");
  const connect = () => {
    optsRef.current = opts;
    setShowOpts(false);
    setGen((g) => g + 1);
  };
  const reconnect = () => {
    optsRef.current = opts;
    setGen((g) => g + 1);
  };
  return (
    <div className="term" ref={wrap}>
      <div className="term-h">
        <span className="on" data-s={conn.state} />
        <span className="term-t">
          <b>shell</b> · {optsRef.current.uid ? `uid ${optsRef.current.uid}` : "root"}@{inst.name}
        </span>
        {conn.state === "connecting" && <span className="dim">connecting…</span>}
        <span className="r">
          <button className="btn btn-q btn-sm" aria-expanded={showOpts} onClick={() => setShowOpts((v) => !v)}>
            Options
          </button>
          <button className="btn btn-q btn-sm" onClick={() => termRef.current?.clear()}>
            Clear
          </button>
          <FullBtn target={wrap} />
          <button className="btn btn-q btn-sm" onClick={reconnect}>
            Reconnect
          </button>
        </span>
      </div>
      {showOpts && (
        <form
          className="term-opts"
          onSubmit={(e) => {
            e.preventDefault();
            if (!uidBad) connect();
          }}
        >
          <label>
            User ID
            <span className={"field" + (uidBad ? " bad" : "")}>
              <input inputMode="numeric" placeholder="0 (root)" value={opts.uid} onChange={(e) => setOpts({ ...opts, uid: e.target.value.trim() })} />
            </span>
          </label>
          <label className="grow">
            Command
            <span className="field">
              <input className="mono" placeholder="Login shell" value={opts.cmd} onChange={(e) => setOpts({ ...opts, cmd: e.target.value })} />
            </span>
          </label>
          <label>
            Folder
            <span className="field">
              <input className="mono" placeholder="Home folder" value={opts.cwd} onChange={(e) => setOpts({ ...opts, cwd: e.target.value })} />
            </span>
          </label>
          <button type="submit" className="btn btn-p press" disabled={uidBad}>
            Connect
          </button>
        </form>
      )}
      <div className="xterm-box" ref={box}>
        <Ended conn={conn} onReconnect={reconnect} />
      </div>
      <KeyRow send={(d) => { sendRef.current(d); termRef.current?.focus(); }} ctrl={ctrl} />
      <div className="term-f">
        <span>Started {started.current.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</span>
        <span>{size}</span>
        <span>UTF-8</span>
        <span>{isMac ? "Copy with ⌘C, paste with ⌘V" : "Select to copy with Ctrl+C or Ctrl+Shift+C, paste with Ctrl+Shift+V"}</span>
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
  const wrap = useRef<HTMLDivElement>(null);
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
      if (!dead) detach = attach(term, fit, inst.server, inst.project, op, setConn).detach;
      term.write("\r\n");
    })().catch((e) => setConn({ state: "error", msg: e.message }));
    return () => {
      dead = true;
      detach();
      term.dispose();
    };
  }, [inst.server, inst.name, inst.project, inst.type, gen]);
  return (
    <div className="term" ref={wrap}>
      <div className="term-h">
        <span className="on" data-s={conn.state} />
        <span>
          <b>console</b> · {inst.name}
        </span>
        {conn.state === "connecting" && <span className="dim">connecting…</span>}
        <span className="r">
          <FullBtn target={wrap} />
          <button className="btn btn-q btn-sm" onClick={() => setGen((g) => g + 1)}>
            Reconnect
          </button>
        </span>
      </div>
      <div className="xterm-box" ref={box}>
        <Ended conn={conn} onReconnect={() => setGen((g) => g + 1)} />
      </div>
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
