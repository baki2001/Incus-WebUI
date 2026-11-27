import type { ReactNode } from "react";

const sv = (p: ReactNode, s = 16) => (
  <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {p}
  </svg>
);

export const ic = {
  home: sv(<><rect x="2" y="2" width="5" height="7" rx="1.3" /><rect x="9" y="2" width="5" height="4" rx="1.3" /><rect x="9" y="8" width="5" height="6" rx="1.3" /><rect x="2" y="11" width="5" height="3" rx="1.3" /></>),
  inst: sv(<path d="M8 1.9 13.6 5v6.1L8 14.2 2.4 11.1V5ZM2.4 5 8 8.1 13.6 5M8 8.1v6.1" />),
  img: sv(<path d="M8 2 14 5 8 8 2 5ZM2 8.25l6 3 6-3M2 11.25l6 3 6-3" />),
  disk: sv(<><ellipse cx="8" cy="4" rx="5.5" ry="2" /><path d="M2.5 4v8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2V4M2.5 8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2" /></>),
  net: sv(<><circle cx="8" cy="3.5" r="1.9" /><circle cx="3.5" cy="12.5" r="1.9" /><circle cx="12.5" cy="12.5" r="1.9" /><path d="M8 5.4V8M3.5 10.6V9.5A1.5 1.5 0 0 1 5 8h6a1.5 1.5 0 0 1 1.5 1.5v1.1" /></>),
  prof: sv(<><path d="M2.5 4.5h5.6M11.9 4.5h1.6M2.5 11.5h1.6M7.9 11.5h5.6" /><circle cx="10" cy="4.5" r="1.9" /><circle cx="6" cy="11.5" r="1.9" /></>),
  host: sv(<><rect x="2" y="2.5" width="12" height="5" rx="1.5" /><rect x="2" y="8.5" width="12" height="5" rx="1.5" /><path d="M8.5 5h3M8.5 11h3M4.75 5h.01M4.75 11h.01" /></>),
  gear: sv(<><path d="M6.18 3.56L6.73 1.73L9.27 1.73L9.82 3.56L9.85 3.57L11.54 2.67L13.33 4.46L12.43 6.15L12.44 6.18L14.27 6.73L14.27 9.27L12.44 9.82L12.43 9.85L13.33 11.54L11.54 13.33L9.85 12.43L9.82 12.44L9.27 14.27L6.73 14.27L6.18 12.44L6.15 12.43L4.46 13.33L2.67 11.54L3.57 9.85L3.56 9.82L1.73 9.27L1.73 6.73L3.56 6.18L3.57 6.15L2.67 4.46L4.46 2.67L6.15 3.57Z" /><circle cx="8" cy="8" r="2" /></>),
  chev: sv(<path d="M5 6.5 8 3.5l3 3M5 9.5l3 3 3-3" />, 12),
  down: sv(<path d="m4 6 4 4 4-4" />, 12),
  right: sv(<path d="m6 3.5 4.5 4.5L6 12.5" />, 14),
  side: sv(<><rect x="2" y="2.5" width="12" height="11" rx="2" /><path d="M6 2.5v11" /></>, 15),
  search: sv(<><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" /></>, 15),
  plus: sv(<path d="M8 3v10M3 8h10" />, 14),
  more: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="3.5" cy="8" r="1.2" /><circle cx="8" cy="8" r="1.2" /><circle cx="12.5" cy="8" r="1.2" />
    </svg>
  ),
  play: (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
      <path d="M4 2.6v8.8a.6.6 0 0 0 .9.5l7-4.4a.6.6 0 0 0 0-1L4.9 2.1a.6.6 0 0 0-.9.5z" />
    </svg>
  ),
  stop: (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
      <rect x="2" y="2" width="8" height="8" rx="1.5" />
    </svg>
  ),
  pause: (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
      <rect x="2.5" y="2" width="2.6" height="8" rx="1" />
      <rect x="6.9" y="2" width="2.6" height="8" rx="1" />
    </svg>
  ),
  restart: sv(<path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3" />, 14),
  snap: sv(<><path d="M2.5 5.5h2l1.2-2h4.6l1.2 2h2v8h-11z" /><circle cx="8" cy="9.3" r="2.3" /></>, 14),
  term: sv(<path d="m3 4.5 3.5 3.5L3 11.5M8.5 12H13" />, 14),
  copy: sv(<><rect x="5" y="5" width="8.5" height="8.5" rx="1.5" /><path d="M11 5V3.5a1 1 0 0 0-1-1H3.5a1 1 0 0 0-1 1V10a1 1 0 0 0 1 1H5" /></>, 13),
  x: sv(<path d="m4 4 8 8M12 4l-8 8" />, 14),
  out: sv(<path d="M6 13.5H3.5a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1H6M10.5 11l3-3-3-3M13.5 8H6" />, 14),
  ct: sv(<><rect x="2.5" y="2.5" width="11" height="11" rx="2" /><path d="M2.5 6.5h11" /></>, 14),
  vm: sv(<><rect x="2" y="3" width="12" height="8" rx="1.5" /><path d="M5.5 13.5h5" /></>, 14),
  folder: sv(<path d="M2 4.5a1 1 0 0 1 1-1h3.2l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />, 15),
  file: sv(<><path d="M4 1.8h5L12.5 5v9.2H4z" /><path d="M9 1.8V5h3.5" /></>, 15),
  link: sv(<path d="M6.5 9.5 9.5 6.5M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.5l-1 1A2.5 2.5 0 0 1 4.5 9l1-1" />, 15),
  up: sv(<path d="M8 13V3M4 7l4-4 4 4" />, 14),
  dl: sv(<path d="M8 3v8M4.5 7.5 8 11l3.5-3.5M3 13.5h10" />, 14),
  trash: sv(<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 9h5.8l.6-9" />, 14),
  screen: sv(<><rect x="1.5" y="2.5" width="13" height="9" rx="1.5" /><path d="M5.5 14h5" /></>, 14),
  kbd: sv(<><rect x="1.5" y="4" width="13" height="8" rx="1.5" /><path d="M4 7h.01M6.5 7h.01M9 7h.01M11.5 7h.01M5 9.5h6" /></>, 14),
  pulse: sv(<path d="M1.5 8.5h2.5l2-5 3.5 9 2-4h3" />),
  proj: sv(<path d="M2 4.5a1 1 0 0 1 1-1h3.2l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1ZM2 7h12" />),
  log: sv(<path d="M4 2h5.5l3 3v8.5a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5V2.5A.5.5 0 0 1 4 2ZM9.5 2v3h3M5.75 8h4.5M5.75 10.75h3" />),
  port: sv(<><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="M5.25 6.5h5.5v3H9.5V11h-3V9.5H5.25Z" /></>),
  acl: sv(<path d="M8 1.75 13 3.6v4.1c0 3.2-2.2 5.4-5 6.55C5.2 13.1 3 10.9 3 7.7V3.6ZM5.75 8l1.5 1.5 3-3" />),
  ipam: sv(<>{[0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => <rect key={r * 3 + c} x={2 + c * 4.25} y={2 + r * 4.25} width="3.25" height="3.25" rx=".8" />))}</>),
  tunnel: sv(<path d="M3 13.5V8a5 5 0 0 1 10 0v5.5M6 13.5V8.5a2 2 0 0 1 4 0v5ZM1.5 13.5h13" />),
  volume: sv(<><rect x="2" y="4.5" width="12" height="7" rx="1.5" /><path d="M4.5 8h4M11.25 8h.01" /></>),
  bucket: sv(<><ellipse cx="8" cy="4" rx="5.5" ry="1.75" /><path d="M2.5 4l1.25 8.6c.1.8 1.9 1.4 4.25 1.4s4.15-.6 4.25-1.4L13.5 4" /></>),
  iso: sv(<><circle cx="8" cy="8" r="5.75" /><circle cx="8" cy="8" r="1.6" /><path d="M8 3.75A4.25 4.25 0 0 1 12.25 8" /></>),
  tasks: sv(<><path d="m2 3.75 1.3 1.3 2.3-2.4M2 8.25l1.3 1.3 2.3-2.4M8 4h6M8 8.5h6M8 13h6" /><circle cx="3.8" cy="12.9" r="1.6" /></>),
  warn: sv(<path d="M7.1 2.55a1 1 0 0 1 1.8 0l5.4 9.6a1 1 0 0 1-.9 1.5H2.6a1 1 0 0 1-.9-1.5ZM8 6.3v3M8 11.3h.01" />),
  star: sv(<path d="m8 2 1.8 3.8 4.1.5-3 2.9.8 4.1L8 11.3l-3.7 2 .8-4.1-3-2.9 4.1-.5z" />, 14),
  starOn: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
      <path d="m8 2 1.8 3.8 4.1.5-3 2.9.8 4.1L8 11.3l-3.7 2 .8-4.1-3-2.9 4.1-.5z" />
    </svg>
  ),
  edit: sv(<path d="M10.5 2.5 13.5 5.5 5.5 13.5H2.5v-3z" />, 14),
  backup: sv(<path d="M2.75 8A5.25 5.25 0 1 0 4.35 4.25M2.6 2.6v2.4H5M8 5.25V8l2 1.5" />),
  cloud: sv(<path d="M4.5 12.5a3 3 0 0 1-.4-6 4 4 0 0 1 7.7-.9 3.4 3.4 0 0 1 .7 6.9z" />, 14),
  shield: sv(<path d="M8 1.8 13 3.7v4c0 3.2-2.2 5.4-5 6.5-2.8-1.1-5-3.3-5-6.5v-4z" />, 14),
  sun: sv(<><circle cx="8" cy="8" r="2.8" /><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" /></>, 14),
  moon: sv(<path d="M13 9.6A5.5 5.5 0 1 1 6.4 3a4.5 4.5 0 0 0 6.6 6.6z" />, 14),
  auto: sv(<><circle cx="8" cy="8" r="5.5" /><path d="M8 2.5v11a5.5 5.5 0 0 0 0-11z" fill="currentColor" stroke="none" /></>, 14),
  kyoto: sv(<><rect x="2" y="2.5" width="12" height="11" rx="2" /><rect x="2" y="2.5" width="4.5" height="11" rx="1.5" fill="currentColor" stroke="none" /></>, 14),
  menu: sv(<path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />),
  grip: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="5.5" cy="4" r="1.2" /><circle cx="10.5" cy="4" r="1.2" />
      <circle cx="5.5" cy="8" r="1.2" /><circle cx="10.5" cy="8" r="1.2" />
      <circle cx="5.5" cy="12" r="1.2" /><circle cx="10.5" cy="12" r="1.2" />
    </svg>
  ),
  full: sv(<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" />, 14),
};

export function Mark() {
  return (
    <svg className="mark" viewBox="0 0 22 22" aria-hidden="true">
      <rect x="2" y="3" width="18" height="4.5" rx="2.25" fill="var(--ink)" />
      <rect x="2" y="9" width="18" height="4.5" rx="2.25" fill="var(--ink)" opacity=".45" />
      <rect x="2" y="15" width="10" height="4.5" rx="2.25" fill="var(--cta, var(--accent))" />
    </svg>
  );
}
