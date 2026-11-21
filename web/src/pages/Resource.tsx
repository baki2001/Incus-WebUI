import { useEffect, useState, type ReactNode } from "react";
import YAML from "yaml";
import { ic } from "../icons";
import { Dialog, Seg, Sheet } from "../ui";
import { diffLines } from "./Config";

// EditSheet edits one Incus object (network, pool, profile, project...) as a
// form, with a YAML view and a review of the changes before they're applied.
// The same sheet creates new objects: then there's no review step.
export function EditSheet<T extends object>({
  open,
  onClose,
  title,
  value,
  form,
  info,
  onSave,
  onDelete,
  create,
  saveLabel,
  yaml = true,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  value: T | null;
  form: (draft: T, set: (fn: (d: T) => void) => void) => ReactNode;
  info?: ReactNode;
  onSave: (draft: T) => Promise<boolean | undefined>;
  onDelete?: () => void;
  create?: boolean;
  saveLabel?: string;
  yaml?: boolean;
}) {
  const [draft, setDraft] = useState<T | null>(value);
  const [view, setView] = useState<"form" | "yaml">("form");
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setDraft(value ? JSON.parse(JSON.stringify(value)) : null);
      setView("form");
      setErr("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, value && JSON.stringify(value)]);

  const set = (fn: (d: T) => void) =>
    setDraft((d) => {
      const n = JSON.parse(JSON.stringify(d));
      fn(n);
      return n;
    });
  // Pure: it runs during render for the review dialog, so it must not set state
  // (that caused a render loop, React error #301).
  const parseYaml = (): { v: T | null; err: string } => {
    try {
      const v = YAML.parse(text) as T;
      if (v === null || typeof v !== "object") return { v: null, err: "The YAML must describe an object." };
      return { v, err: "" };
    } catch (e: any) {
      return { v: null, err: e.message };
    }
  };
  const fromYaml = (): T | null => {
    const r = parseYaml();
    setErr(r.err);
    return r.v;
  };
  const switchView = (v: "form" | "yaml") => {
    if (v === "yaml") setText(YAML.stringify(draft));
    else {
      const d = fromYaml();
      if (!d) return;
      setDraft(d);
    }
    setView(v);
  };
  const current = () => (view === "yaml" ? fromYaml() : draft);
  const orig = value ? YAML.stringify(value) : "";
  const dirty = open && !review && (view === "yaml" ? text !== YAML.stringify(draft) : !!draft && JSON.stringify(draft) !== JSON.stringify(value));
  const save = async (d: T) => {
    setBusy(true);
    const ok = await onSave(d).finally(() => setBusy(false));
    if (ok) {
      setReview(false);
      onClose();
    }
  };
  const next = review ? (view === "yaml" ? parseYaml().v : draft) : null;

  return (
    <>
      <Sheet
        open={open}
        onClose={onClose}
        title={title}
        dirty={dirty}
        wide
        head={
          yaml ? (
            <Seg
              value={view}
              onChange={switchView}
              label="View"
              options={[
                { v: "form", l: "Form" },
                { v: "yaml", l: <span className="ac">YAML</span> },
              ]}
            />
          ) : undefined
        }
        footer={
          <>
            {onDelete && (
              <button className="btn btn-q press l" style={{ color: "var(--err)" }} onClick={onDelete}>
                {ic.trash}Delete
              </button>
            )}
            {!onDelete && <span className="l" />}
            <button className="btn btn-s press" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn btn-p press"
              disabled={busy}
              onClick={() => {
                const d = current();
                if (!d) return;
                if (create) save(d);
                else setReview(true);
              }}
            >
              {saveLabel || (create ? "Create" : "Review and save")}
            </button>
          </>
        }
      >
        {info}
        {draft && view === "form" && form(draft, set)}
        {view === "yaml" && (
          <>
            <textarea className="yaml box" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} style={{ minHeight: "50vh" }} />
            {err && <div className="hint bad">{err}</div>}
          </>
        )}
      </Sheet>
      <Dialog open={review} onClose={() => setReview(false)} size="md">
        <div className="dlg-b">
          <h2>Review changes</h2>
          {next && YAML.stringify(next) === orig ? (
            <p>Nothing changed.</p>
          ) : (
            <div className="diff">
              {next &&
                diffLines(orig, YAML.stringify(next))
                  .filter((l, i, arr) => l.t !== "c" || arr.slice(Math.max(0, i - 2), i + 3).some((x) => x.t !== "c"))
                  .map((l, i) => (
                    <div key={i} className={l.t}>
                      {l.t === "c" ? "  " + l.s : l.s}
                    </div>
                  ))}
            </div>
          )}
        </div>
        <div className="dlg-f">
          <button className="btn btn-s press" onClick={() => setReview(false)}>
            Keep editing
          </button>
          <button className="btn btn-p press" disabled={busy || !next || YAML.stringify(next) === orig} onClick={() => next && save(next)}>
            Apply
          </button>
        </div>
      </Dialog>
    </>
  );
}

// Page header with title and actions, shared by the list pages.
export function PageHead({ title, children, sub }: { title: string; children?: ReactNode; sub?: ReactNode }) {
  return (
    <>
      <div className="ph">
        <h1>{title}</h1>
        <div className="r">{children}</div>
      </div>
      {sub}
    </>
  );
}

export function Search({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="field fsearch">
      {ic.search}
      <input placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

export function matches(q: string, ...parts: (string | undefined | null)[]) {
  const ql = q.trim().toLowerCase();
  return !ql || parts.some((p) => (p || "").toLowerCase().includes(ql));
}

// Used-by count with the list in a tooltip.
export function UsedBy({ list }: { list?: string[] }) {
  const n = list?.length || 0;
  if (!n) return <span className="dim">0</span>;
  const names = list!.map((u) => decodeURIComponent(u.split("?")[0].split("/").slice(2).join(" "))).join("\n");
  return (
    <span className="ub" title={names}>
      {n}
    </span>
  );
}
