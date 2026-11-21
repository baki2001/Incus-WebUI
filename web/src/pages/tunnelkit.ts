// Browser-side helpers for WireGuard tunnels: key generation and a QR code
// encoder. Private keys are made here and never sent to the server.

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));

// --- X25519 ---------------------------------------------------------------
// WebCrypto does it where supported. It's missing in older browsers and on
// plain-http pages (no crypto.subtle), so there is a small BigInt fallback.

const P = (1n << 255n) - 19n;
const mod = (a: bigint) => ((a % P) + P) % P;
function inv(a: bigint): bigint {
  let r = 1n,
    b = a,
    e = P - 2n;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return r;
}

export function clamp(k: Uint8Array): Uint8Array {
  const c = Uint8Array.from(k);
  c[0] &= 248;
  c[31] &= 127;
  c[31] |= 64;
  return c;
}

// RFC 7748 Montgomery ladder.
export function x25519(scalar: Uint8Array, u: Uint8Array): Uint8Array {
  const k = clamp(scalar);
  let kn = 0n;
  for (let i = 31; i >= 0; i--) kn = (kn << 8n) | BigInt(k[i]);
  const uu = Uint8Array.from(u);
  uu[31] &= 127;
  let x1 = 0n;
  for (let i = 31; i >= 0; i--) x1 = (x1 << 8n) | BigInt(uu[i]);
  let x2 = 1n,
    z2 = 0n,
    x3 = x1,
    z3 = 1n,
    swap = 0n;
  for (let t = 254; t >= 0; t--) {
    const kt = (kn >> BigInt(t)) & 1n;
    swap ^= kt;
    if (swap) [x2, x3, z2, z3] = [x3, x2, z3, z2];
    swap = kt;
    const A = mod(x2 + z2),
      AA = mod(A * A),
      B = mod(x2 - z2),
      BB = mod(B * B),
      E = mod(AA - BB),
      C = mod(x3 + z3),
      D = mod(x3 - z3),
      DA = mod(D * A),
      CB = mod(C * B);
    x3 = mod((DA + CB) * (DA + CB));
    z3 = mod(x1 * mod((DA - CB) * (DA - CB)));
    x2 = mod(AA * BB);
    z2 = mod(E * mod(AA + 121665n * E));
  }
  if (swap) [x2, x3, z2, z3] = [x3, x2, z3, z2];
  let r = mod(x2 * inv(z2));
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = Number(r & 255n);
    r >>= 8n;
  }
  return out;
}

const BASE = (() => {
  const b = new Uint8Array(32);
  b[0] = 9;
  return b;
})();

export type KeyPair = { priv: string; pub: string; via: "webcrypto" | "fallback" };

export async function genKeyPair(forceFallback = false): Promise<KeyPair> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle && !forceFallback) {
    try {
      const k = (await subtle.generateKey({ name: "X25519" } as any, true, ["deriveBits"])) as CryptoKeyPair;
      const pkcs8 = new Uint8Array(await subtle.exportKey("pkcs8", k.privateKey));
      const pub = new Uint8Array(await subtle.exportKey("raw", k.publicKey));
      return { priv: b64(clamp(pkcs8.slice(-32))), pub: b64(pub), via: "webcrypto" };
    } catch {
      /* not supported: use the fallback */
    }
  }
  const priv = clamp(crypto.getRandomValues(new Uint8Array(32)));
  return { priv: b64(priv), pub: b64(x25519(priv, BASE)), via: "fallback" };
}

export function genPSK(): string {
  return b64(crypto.getRandomValues(new Uint8Array(32)));
}

export function publicFromPrivate(privB64: string): string {
  return b64(x25519(Uint8Array.from(atob(privB64), (c) => c.charCodeAt(0)), BASE));
}

// --- QR code (byte mode, error correction level L) ---------------------------

const ECC_PER_BLOCK = [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30];
const NUM_BLOCKS = [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25];

function rawModules(ver: number): number {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const n = Math.floor(ver / 7) + 2;
    r -= (25 * n - 10) * n - 55;
    if (ver >= 7) r -= 36;
  }
  return r;
}
const dataCodewords = (ver: number) => Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ver] * NUM_BLOCKS[ver];

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(deg: number): number[] {
  const r = new Array(deg).fill(0);
  r[deg - 1] = 1;
  let root = 1;
  for (let i = 0; i < deg; i++) {
    for (let j = 0; j < deg; j++) {
      r[j] = gfMul(r[j], root);
      if (j + 1 < deg) r[j] ^= r[j + 1];
    }
    root = gfMul(root, 2);
  }
  return r;
}

function rsRemainder(data: number[], div: number[]): number[] {
  const r = new Array(div.length).fill(0);
  for (const b of data) {
    const f = b ^ r.shift()!;
    r.push(0);
    div.forEach((c, i) => (r[i] ^= gfMul(c, f)));
  }
  return r;
}

export type QR = { size: number; get: (x: number, y: number) => boolean };

export function makeQR(text: string, forceMask?: number): QR {
  const bytes = new TextEncoder().encode(text);
  let ver = 1;
  for (; ver <= 40; ver++) {
    const cc = ver < 10 ? 8 : 16;
    if (4 + cc + bytes.length * 8 <= dataCodewords(ver) * 8) break;
  }
  if (ver > 40) throw new Error("Too much data for a QR code.");

  const bits: number[] = [];
  const put = (v: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, ver < 10 ? 8 : 16);
  bytes.forEach((b) => put(b, 8));
  const cap = dataCodewords(ver) * 8;
  put(0, Math.min(4, cap - bits.length));
  while (bits.length % 8) bits.push(0);
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(""), 2));

  // split into blocks, add error correction, interleave
  const nb = NUM_BLOCKS[ver],
    ecl = ECC_PER_BLOCK[ver],
    raw = Math.floor(rawModules(ver) / 8),
    shortCount = nb - (raw % nb),
    shortLen = Math.floor(raw / nb);
  const div = rsDivisor(ecl);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < nb; i++) {
    const len = shortLen - ecl + (i < shortCount ? 0 : 1);
    const d = data.slice(k, k + len);
    k += len;
    const e = rsRemainder(d, div);
    if (i < shortCount) d.push(0); // placeholder so data parts line up
    blocks.push(d.concat(e));
  }
  const all: number[] = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((b, j) => {
      if (i !== shortLen - ecl || j >= shortCount) all.push(b[i]);
    });
  }

  const size = ver * 4 + 17;
  const mods: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x: number, y: number, dark: boolean) => {
    mods[y][x] = dark;
    fn[y][x] = true;
  };

  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy)),
          x = cx + dx,
          y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
      }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  if (ver > 1) {
    const n = Math.floor(ver / 7) + 2;
    const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
    const pos = [6];
    for (let p = size - 7; pos.length < n; p -= step) pos.splice(1, 0, p);
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
  }
  const drawFormat = (mask: number) => {
    const d = (1 << 3) | mask; // level L = 01
    let rem = d;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const fb = ((d << 10) | rem) ^ 0x5412;
    const bit = (i: number) => ((fb >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  drawFormat(0);
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const vb = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3),
        b = Math.floor(i / 3),
        dark = ((vb >>> i) & 1) !== 0;
      set(a, b, dark);
      set(b, a, dark);
    }
  }

  // place data in the zigzag
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j,
          up = ((right + 1) & 2) === 0,
          y = up ? size - 1 - vert : vert;
        if (!fn[y][x] && i < all.length * 8) {
          mods[y][x] = ((all[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
          i++;
        }
      }
    }
  }

  const maskFn = [
    (x: number, y: number) => (x + y) % 2 === 0,
    (_: number, y: number) => y % 2 === 0,
    (x: number) => x % 3 === 0,
    (x: number, y: number) => (x + y) % 3 === 0,
    (x: number, y: number) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x: number, y: number) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x: number, y: number) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x: number, y: number) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];
  const applyMask = (m: number) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && maskFn[m](x, y)) mods[y][x] = !mods[y][x];
  };
  const penalty = (): number => {
    let p = 0;
    const line = (get: (a: number) => boolean) => {
      let run = 1;
      for (let a = 1; a < size; a++) {
        if (get(a) === get(a - 1)) {
          run++;
          if (run === 5) p += 3;
          else if (run > 5) p++;
        } else run = 1;
      }
    };
    for (let y = 0; y < size; y++) line((x) => mods[y][x]);
    for (let x = 0; x < size; x++) line((y) => mods[y][x]);
    for (let y = 0; y < size - 1; y++)
      for (let x = 0; x < size - 1; x++) if (mods[y][x] === mods[y][x + 1] && mods[y][x] === mods[y + 1][x] && mods[y][x] === mods[y + 1][x + 1]) p += 3;
    const pat = [true, false, true, true, true, false, true];
    const finderLike = (get: (k: number) => boolean, at: number) => pat.every((v, k) => get(at + k) === v);
    const lightRun = (get: (k: number) => boolean, a: number, b: number) => {
      for (let k = a; k < b; k++) if (k >= 0 && k < size && get(k)) return false;
      return true;
    };
    for (let a = 0; a < size; a++) {
      for (const get of [(k: number) => mods[a][k], (k: number) => mods[k][a]]) {
        for (let at = 0; at + 7 <= size; at++) {
          if (finderLike(get, at) && (lightRun(get, at - 4, at) || lightRun(get, at + 7, at + 11))) p += 40;
        }
      }
    }
    let dark = 0;
    for (const row of mods) for (const v of row) if (v) dark++;
    p += (Math.ceil(Math.abs(dark * 20 - size * size * 10) / (size * size)) - 1) * 10;
    return p;
  };
  let best = 0,
    bestP = Infinity;
  for (let m = forceMask ?? 0; m < (forceMask ?? 7) + 1; m++) {
    applyMask(m);
    drawFormat(m);
    const p = penalty();
    if (p < bestP) {
      best = m;
      bestP = p;
    }
    applyMask(m); // undo
  }
  applyMask(best);
  drawFormat(best);
  return { size, get: (x, y) => mods[y][x] };
}

// qrPath returns an SVG path (and size incl. quiet zone) for a QR code.
export function qrPath(text: string): { d: string; size: number } {
  const q = makeQR(text);
  const quiet = 4;
  let d = "";
  for (let y = 0; y < q.size; y++) {
    let x = 0;
    while (x < q.size) {
      if (!q.get(x, y)) {
        x++;
        continue;
      }
      let w = 1;
      while (x + w < q.size && q.get(x + w, y)) w++;
      d += `M${x + quiet} ${y + quiet}h${w}v1h-${w}z`;
      x += w;
    }
  }
  return { d, size: q.size + quiet * 2 };
}
