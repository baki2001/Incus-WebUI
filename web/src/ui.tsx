import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { stateClass } from "./api";
import { ic } from "./icons";
import { useApp } from "./state";

export function useOutside(ref: React.RefObject<HTMLElement | null>, fn: () => void, on = true) {
  useEffect(() => {
    if (!on) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) fn();
    };
    const k = (e: KeyboardEvent) => e.key === "Escape" && fn();
    document.addEventListener("mousedown", h);
    document.addEventListener("keydown", k);
    return () => {
      document.removeEventListener("mousedown", h);
      document.removeEventListener("keydown", k);
    };
  }, [ref, fn, on]);
}

export function Status({ status }: { status: string }) {
  return <span className={"st " + stateClass(status)}>{status}</span>;
}

// Overlay mounts, then animates in; unmounts after animating out.
function useShown(open: boolean) {
  const [mounted, setMounted] = useState(open);
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (open) {
      setMounted(true);
      const r = requestAnimationFrame(() => requestAnimationFrame(() => setOn(true)));
      return () => cancelAnimationFrame(r);
    }
    setOn(false);
    const t = setTimeout(() => setMounted(false), 280);
    return () => clearTimeout(t);
  }, [open]);
  return { mounted, on };
}

export function Dialog({ open, onClose, children, size }: { open: boolean; onClose: () => void; children: ReactNode; size?: "sm" | "md" }) {
  const { mounted, on } = useShown(open);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [open, onClose]);
  if (!mounted) return null;
  return (
    <>
      <div className={"scrim" + (on ? " on" : "")} onClick={onClose} />
      <div className={"dlg sq " + (size || "") + (on ? " on" : "")} role="dialog" aria-modal="true">
        {children}
      </div>
    </>
  );
}

export function Sheet({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode }) {
  const { mounted, on } = useShown(open);
  if (!mounted) return null;
  return (
    <>
      <div className={"scrim" + (on ? " on" : "")} onClick={onClose} />
      <div className={"sheet" + (on ? " on" : "")} role="dialog" aria-modal="true" aria-label={title}>
        <div className="sheet-h">
          <h2>{title}</h2>
          <button className="btn btn-q ib" onClick={onClose} aria-label="Close">
            {ic.x}
          </button>
        </div>
        <div className="sheet-b">{children}</div>
        {footer && <div className="sheet-f">{footer}</div>}
      </div>
    </>
  );
}

type ConfirmOpts = { title: string; body: ReactNode; confirm: string; danger?: boolean; typeToConfirm?: string };
let openConfirm: (o: ConfirmOpts) => Promise<boolean> = async () => false;
export const confirmDialog = (o: ConfirmOpts) => openConfirm(o);

export function ConfirmHost() {
  const [st, setSt] = useState<{ o: ConfirmOpts; res: (b: boolean) => void } | null>(null);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  openConfirm = (o) =>
    new Promise((res) => {
      setTyped("");
      setSt({ o, res });
      setOpen(true);
    });
  const close = (v: boolean) => {
    st?.res(v);
    setOpen(false);
  };
  const o = st?.o;
  const ok = !o?.typeToConfirm || typed === o.typeToConfirm;
  return (
    <Dialog open={open} onClose={() => close(false)} size="sm">
      {o && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (ok) close(true);
          }}
        >
          <div className="dlg-b">
            <h2>{o.title}</h2>
            <p>{o.body}</p>
            {o.typeToConfirm && (
              <div className="fl" style={{ marginTop: 14 }}>
                <label>
                  Type <span className="mono">{o.typeToConfirm}</span> to confirm
                </label>
                <div className="field">
                  <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} />
                </div>
              </div>
            )}
          </div>
          <div className="dlg-f">
            <button type="button" className="btn btn-s press" onClick={() => close(false)}>
              Cancel
            </button>
            <button type="submit" className={"btn press " + (o.danger ? "btn-d" : "btn-p")} disabled={!ok} autoFocus={!o.typeToConfirm}>
              {o.confirm}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

export function Menu({ button, children, align = "right" }: { button: (p: { onClick: () => void; "aria-expanded": boolean }) => ReactNode; children: (close: () => void) => ReactNode; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOutside(ref, () => setOpen(false), open);
  return (
    <div ref={ref} style={{ position: "relative" }}>
      {button({ onClick: () => setOpen((o) => !o), "aria-expanded": open })}
      {open && (
        <div className="menu" style={align === "left" ? { left: 0, right: "auto", transformOrigin: "top left" } : undefined}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: { v: T; l: ReactNode }[]; onChange: (v: T) => void; label?: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.v} type="button" aria-pressed={value === o.v} onClick={() => onChange(o.v)}>
          {o.l}
        </button>
      ))}
    </div>
  );
}

// Tabs with a sliding indicator; content slides in the direction of travel.
export function Tabs<T extends string>({ value, tabs, onChange }: { value: T; tabs: { v: T; l: string; hidden?: boolean }[]; onChange: (v: T) => void }) {
  const wrap = useRef<HTMLDivElement>(null);
  const ind = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const b = wrap.current?.querySelector<HTMLButtonElement>('button[aria-selected="true"]');
    if (b && ind.current) ind.current.style.transform = `translateX(${b.offsetLeft + 12}px) scaleX(${b.offsetWidth - 24})`;
  });
  return (
    <div className="tabs" role="tablist" ref={wrap}>
      {tabs
        .filter((t) => !t.hidden)
        .map((t) => (
          <button key={t.v} role="tab" aria-selected={t.v === value} onClick={() => onChange(t.v)}>
            <span className="lbl" data-t={t.l}>
              <span>{t.l}</span>
            </span>
          </button>
        ))}
      <span className="ind" ref={ind} />
    </div>
  );
}

export function CopyBtn({ text }: { text: string }) {
  const { toast } = useApp();
  return (
    <button
      className="copy slop"
      aria-label="Copy"
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard?.writeText(text).then(() => toast("Copied"));
      }}
    >
      {ic.copy}
    </button>
  );
}

export function SkRows({ cols, rows = 6 }: { cols: number; rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, i) => (
        <tr key={i} style={{ cursor: "default" }}>
          {Array.from({ length: cols }).map((_, j) => (
            <td key={j}>
              <span className="sk" style={{ display: "inline-block", width: j === 0 ? 120 : 60, height: 12 }} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <b>{title}</b>
      {children && <div className="dim">{children}</div>}
    </div>
  );
}

// middle-truncate long names: keep the start and the end
export function MidTrunc({ text, max = 32 }: { text: string; max?: number }) {
  if (text.length <= max) return <>{text}</>;
  const h = Math.floor((max - 1) / 2);
  return <span title={text}>{text.slice(0, h) + "…" + text.slice(-h)}</span>;
}

export function Field({ label, hint, bad, children }: { label: string; hint?: ReactNode; bad?: boolean; children: ReactNode }) {
  return (
    <div className="fl">
      <label>{label}</label>
      {children}
      <div className={"hint" + (bad ? " bad" : "")}>{hint}</div>
    </div>
  );
}

export function shake(el: HTMLElement | null) {
  if (!el) return;
  el.classList.remove("shake");
  void el.offsetWidth;
  el.classList.add("shake");
}
