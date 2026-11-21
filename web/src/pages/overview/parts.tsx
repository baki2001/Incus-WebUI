import type { ReactNode } from "react";
import type { ServerStatus } from "../../api";
import type { Row } from "../../data";
import type { Cap, Img, Info, Net, Tunnel } from "./model";

// What the elements draw from. undefined means still loading.
export type D = {
  rows?: Row[];
  rowsKey: string | null;
  servers: ServerStatus[];
  info?: Record<string, Info>;
  cap?: Record<string, Cap>;
  nets?: Net[];
  images?: Img[];
  tunnels?: Tunnel[] | null;
};

export function Skel({ lines = 3 }: { lines?: number }) {
  return (
    <div className="b-sk" aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <i key={i} className="sk" style={{ width: `${90 - i * 18}%` }} />
      ))}
    </div>
  );
}

export function Nothing({ children }: { children: ReactNode }) {
  return <p className="b-none">{children}</p>;
}

export function splitBytes(s: string): [string, string] {
  const i = s.indexOf(" ");
  return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i + 1)];
}
