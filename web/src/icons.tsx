import type { ReactNode } from "react";

const sv = (p: ReactNode, s = 16) => (
  <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {p}
  </svg>
);

export const ic = {
  home: sv(<><rect x="2" y="2" width="5" height="5" rx="1.3" /><rect x="9" y="2" width="5" height="5" rx="1.3" /><rect x="2" y="9" width="5" height="5" rx="1.3" /><rect x="9" y="9" width="5" height="5" rx="1.3" /></>),
  inst: sv(<><path d="M8 1.8 13.5 5v6L8 14.2 2.5 11V5z" /><path d="M2.5 5 8 8.2 13.5 5M8 8.2v6" /></>),
  img: sv(<><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="m2.5 11 3.5-3.5 3 3 2-2 2.5 2.5" /></>),
  disk: sv(<><ellipse cx="8" cy="4" rx="5.5" ry="2" /><path d="M2.5 4v8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2V4M2.5 8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2" /></>),
  net: sv(<><circle cx="8" cy="3.5" r="1.8" /><circle cx="3.5" cy="12.5" r="1.8" /><circle cx="12.5" cy="12.5" r="1.8" /><path d="M8 5.3V8l-3.4 3M8 8l3.4 3" /></>),
  prof: sv(<path d="M3 4h10M3 8h10M3 12h6" />),
  host: sv(<><rect x="2" y="2.5" width="12" height="8" rx="1.5" /><path d="M5.5 13.5h5M8 10.5v3" /></>),
  gear: sv(<><circle cx="8" cy="8" r="2.2" /><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" /></>),
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
  pulse: sv(<path d="M1.5 8.5h3l2-5 3 9 2-4h3" />),
  tasks: sv(<path d="m2 4 1.2 1.2L5.5 3M2 10l1.2 1.2L5.5 9M8 4.2h6M8 10.2h6" />),
  warn: sv(<><path d="M8 2.2 14.3 13H1.7z" /><path d="M8 6.5v3M8 11.2h.01" /></>),
  star: sv(<path d="m8 2 1.8 3.8 4.1.5-3 2.9.8 4.1L8 11.3l-3.7 2 .8-4.1-3-2.9 4.1-.5z" />, 14),
  starOn: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
      <path d="m8 2 1.8 3.8 4.1.5-3 2.9.8 4.1L8 11.3l-3.7 2 .8-4.1-3-2.9 4.1-.5z" />
    </svg>
  ),
  edit: sv(<path d="M10.5 2.5 13.5 5.5 5.5 13.5H2.5v-3z" />, 14),
  cloud: sv(<path d="M4.5 12.5a3 3 0 0 1-.4-6 4 4 0 0 1 7.7-.9 3.4 3.4 0 0 1 .7 6.9z" />, 14),
  shield: sv(<path d="M8 1.8 13 3.7v4c0 3.2-2.2 5.4-5 6.5-2.8-1.1-5-3.3-5-6.5v-4z" />, 14),
  sun: sv(<><circle cx="8" cy="8" r="2.8" /><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" /></>, 14),
  moon: sv(<path d="M13 9.6A5.5 5.5 0 1 1 6.4 3a4.5 4.5 0 0 0 6.6 6.6z" />, 14),
  auto: sv(<><circle cx="8" cy="8" r="5.5" /><path d="M8 2.5v11a5.5 5.5 0 0 0 0-11z" fill="currentColor" stroke="none" /></>, 14),
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
