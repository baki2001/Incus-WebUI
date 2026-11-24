import { useState } from "react";
import { ic } from "../../icons";
import { Seg, Sheet, Toggle } from "../../ui";
import { DEFAULTS, ELEMENTS, normalise, type Item, type Size } from "./prefs";

export function Customize({ open, onClose, items, onChange }: { open: boolean; onClose: () => void; items: Item[]; onChange: (i: Item[]) => void }) {
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const move = (from: number, to: number) => {
    if (from === to || to < 0 || to >= items.length) return;
    const next = [...items];
    next.splice(to, 0, next.splice(from, 1)[0]);
    onChange(next);
  };
  const patch = (id: string, p: Partial<Item>) => onChange(items.map((i) => (i.id === id ? { ...i, ...p } : i)));
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Customize Overview"
      footer={
        <>
          <button className="btn btn-s press" onClick={() => onChange(normalise(DEFAULTS))}>
            Reset to default
          </button>
          <button className="btn btn-p press" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <p className="dim cz-note">Choose what the Overview shows and in which order. Drag a row, or use the arrows.</p>
      <ul className="cz">
        {items.map((it, i) => {
          const el = ELEMENTS.find((e) => e.id === it.id)!;
          return (
            <li
              key={it.id}
              className={"cz-r" + (drag === i ? " drag" : "") + (over === i && drag !== null && drag !== i ? " over" : "") + (it.on ? "" : " off")}
              draggable
              onDragStart={(e) => {
                setDrag(i);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(i);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (drag !== null) move(drag, i);
                setDrag(null);
                setOver(null);
              }}
              onDragEnd={() => {
                setDrag(null);
                setOver(null);
              }}
            >
              <span className="cz-grip" aria-hidden="true">
                {ic.grip}
              </span>
              <div className="cz-t">
                <b>{el.title}</b>
                <small className="dim">{el.note}</small>
                {el.sizes && it.on && (
                  <Seg<Size>
                    label={`${el.title} size`}
                    value={it.size || "m"}
                    options={[
                      { v: "s", l: "Small" },
                      { v: "m", l: "Medium" },
                    ]}
                    onChange={(v) => patch(it.id, { size: v })}
                  />
                )}
              </div>
              <div className="cz-a">
                <button className="btn btn-q ib" aria-label={`Move ${el.title} up`} disabled={i === 0} onClick={() => move(i, i - 1)}>
                  {ic.up}
                </button>
                <button className="btn btn-q ib cz-dn" aria-label={`Move ${el.title} down`} disabled={i === items.length - 1} onClick={() => move(i, i + 1)}>
                  {ic.up}
                </button>
                <Toggle on={it.on} onChange={(v) => patch(it.id, { on: v })} label={`Show ${el.title}`} />
              </div>
            </li>
          );
        })}
      </ul>
    </Sheet>
  );
}
