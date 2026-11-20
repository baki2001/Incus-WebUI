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

export function Sheet({ open, onClose, title, children, footer, wide, head }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean; head?: ReactNode }) {
  const { mounted, on } = useShown(open);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && !document.querySelector(".dlg.on") && onClose();
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [open, onClose]);
  if (!mounted) return null;
  return (
    <>
      <div className={"scrim" + (on ? " on" : "")} onClick={onClose} />
      <div className={"sheet" + (wide ? " wide" : "") + (on ? " on" : "")} role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined}>
        <div className="sheet-h">
          <h2>{title}</h2>
          {head}
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
  const ref = useRef<HTMLDivElement>(null);
  useThumb(ref, 'button[aria-pressed="true"]', [value, options.length]);
  return (
    <div className="seg" role="group" aria-label={label} ref={ref}>
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

// ---------- sliding selection thumb ----------
// Puts one .thumb element under the selected child of a group (segmented
// controls, nav lists) and slides it when the selection moves.
export function useThumb(ref: React.RefObject<HTMLElement | null>, selector: string, deps: unknown[]) {
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    let th = box.querySelector<HTMLElement>(":scope > .thumb");
    const place = (animate: boolean) => {
      const el = box.querySelector<HTMLElement>(selector);
      if (!th) return;
      if (!el || el.offsetParent === null) {
        th.style.opacity = "0";
        return;
      }
      if (!animate) th.style.transition = "none";
      th.style.width = el.offsetWidth + "px";
      th.style.height = el.offsetHeight + "px";
      th.style.transform = `translate(${el.offsetLeft}px,${el.offsetTop}px)`;
      th.style.opacity = "1";
      if (!animate) {
        void th.offsetWidth;
        th.style.transition = "";
      }
    };
    if (!th) {
      th = document.createElement("span");
      th.className = "thumb " + (box.dataset.thumb || "pill");
      th.setAttribute("aria-hidden", "true");
      box.prepend(th);
      place(false);
    } else place(true);
    const ro = new ResizeObserver(() => place(false));
    ro.observe(box);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

// ---------- sorting ----------
export type SortState = { k: string; asc: boolean };

export function SortTh({ k, label, sort, setSort, cls = "" }: { k: string; label: string; sort: SortState; setSort: (s: SortState) => void; cls?: string }) {
  const on = sort.k === k;
  return (
    <th className={cls} aria-sort={on ? (sort.asc ? "ascending" : "descending") : undefined}>
      <button className={"sortb" + (on ? " on" : "")} onClick={() => setSort({ k, asc: on ? !sort.asc : true })}>
        {label}
        <span className="arr" aria-hidden="true">
          {on ? (sort.asc ? "↑" : "↓") : "↑"}
        </span>
      </button>
    </th>
  );
}

export function sortRows<T>(rows: T[], sort: SortState, val: (r: T, k: string) => string | number | undefined | null) {
  return rows.slice().sort((a, b) => {
    const x = val(a, sort.k) ?? "",
      y = val(b, sort.k) ?? "";
    const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
    return sort.asc ? c : -c;
  });
}

// ---------- generic table ----------
export type Col<T> = { k: string; label: string; cls?: string; cell: (r: T) => ReactNode; sort?: (r: T) => string | number | undefined | null; hide?: boolean };

export function Table<T>({
  cols,
  rows,
  rowKey,
  onRow,
  loading,
  empty,
  initial,
}: {
  cols: Col<T>[];
  rows: T[] | undefined;
  rowKey: (r: T) => string;
  onRow?: (r: T) => void;
  loading?: boolean;
  empty: ReactNode;
  initial?: SortState;
}) {
  const shown = cols.filter((c) => !c.hide);
  const [sort, setSort] = useState<SortState>(initial || { k: shown[0]?.k || "", asc: true });
  const col = shown.find((c) => c.k === sort.k);
  const list = rows && col?.sort ? sortRows(rows, sort, (r) => col.sort!(r)) : rows || [];
  return (
    <div className="panel tw">
      <table>
        <thead>
          <tr>
            {shown.map((c) =>
              c.sort ? (
                <SortTh key={c.k} k={c.k} label={c.label} sort={sort} setSort={setSort} cls={c.cls} />
              ) : (
                <th key={c.k} className={c.cls}>
                  {c.label}
                </th>
              ),
            )}
          </tr>
        </thead>
        <tbody>
          {!rows && loading && <SkRows cols={shown.length} rows={4} />}
          {list.map((r) => (
            <tr key={rowKey(r)} onClick={onRow ? () => onRow(r) : undefined} style={onRow ? undefined : { cursor: "default" }}>
              {shown.map((c) => (
                <td key={c.k} className={c.cls}>
                  {c.cell(r)}
                </td>
              ))}
            </tr>
          ))}
          {!list.length && (rows || !loading) && (
            <tr className="empty">
              <td colSpan={shown.length} className="emp">
                {empty}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ---------- small form parts ----------
export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
  return <button type="button" className="toggle" role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)} />;
}

// A labelled switch row: title, one line of explanation, switch on the right.
export function TglRow({ title, note, on, onChange }: { title: string; note?: ReactNode; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="tgl">
      <div>
        <b>{title}</b>
        {note && <p>{note}</p>}
      </div>
      <Toggle on={on} onChange={onChange} label={title} />
    </div>
  );
}

export function Input({ value, onChange, bad, mono, ...rest }: { value: string; onChange: (v: string) => void; bad?: boolean; mono?: boolean } & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  return (
    <div className={"field" + (bad ? " bad" : "")}>
      <input className={mono ? "mono" : undefined} value={value} onChange={(e) => onChange(e.target.value)} {...rest} />
    </div>
  );
}

export function Select({ value, onChange, options, ...rest }: { value: string; onChange: (v: string) => void; options: (string | { v: string; l: string })[] } & Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "value" | "onChange">) {
  return (
    <div className="field">
      <select value={value} onChange={(e) => onChange(e.target.value)} {...rest}>
        {options.map((o) => (typeof o === "string" ? <option key={o}>{o}</option> : <option key={o.v} value={o.v}>{o.l}</option>))}
      </select>
    </div>
  );
}

// Edits a string map (config keys) as rows.
export function KVEditor({ value, onChange, keys = [], hide = () => false }: { value: Record<string, string>; onChange: (v: Record<string, string>) => void; keys?: string[]; hide?: (k: string) => boolean }) {
  const entries = Object.entries(value).filter(([k]) => !hide(k));
  const listId = useRef("kv" + Math.random().toString(36).slice(2)).current;
  const set = (i: number, k: string, v: string) => {
    const next: Record<string, string> = {};
    const e = entries.slice();
    e[i] = [k, v];
    for (const [kk, vv] of Object.entries(value)) if (hide(kk)) next[kk] = vv;
    for (const [kk, vv] of e) next[kk] = vv;
    onChange(next);
  };
  return (
    <div className="kved">
      {entries.map(([k, v], i) => (
        <div className="kvr" key={i}>
          <div className="field">
            <input className="mono" list={listId} value={k} placeholder="key" onChange={(e) => set(i, e.target.value, v)} />
          </div>
          <div className="field">
            <input className="mono" value={v} placeholder="value" onChange={(e) => set(i, k, e.target.value)} />
          </div>
          <button
            type="button"
            className="btn btn-q ib btn-sm"
            aria-label={"Remove " + k}
            onClick={() => {
              const next = { ...value };
              delete next[k];
              onChange(next);
            }}
          >
            {ic.x}
          </button>
        </div>
      ))}
      <datalist id={listId}>
        {keys.filter((k) => !(k in value)).map((k) => (
          <option key={k} value={k} />
        ))}
      </datalist>
      <div>
        <button type="button" className="btn btn-s btn-sm press" onClick={() => onChange({ ...value, "": "" })} disabled={"" in value}>
          {ic.plus}Add setting
        </button>
      </div>
    </div>
  );
}

// A section inside a sheet: small heading, optional action, content.
export function SheetSec({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="ss">
      <div className="ss-h">
        <h3>{title}</h3>
        {action}
      </div>
      {children}
    </div>
  );
}

export function errText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}
