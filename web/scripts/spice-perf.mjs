// Speed fixes for @spice-project/spice-html5 0.2.1, applied at build time.
//
// 1. wire.js joins websocket frames by copying the whole buffer again for
//    every new frame. A full-screen update of a few MB that arrives in small
//    frames gets copied hundreds of times. The new reader keeps the frames and
//    copies each message once.
// 2. display.js turns every JPEG (screen updates and video streams) into a
//    percent-encoded data: URL, one byte at a time. That is three string
//    appends per byte and a big URL to parse. A Blob URL skips all of that.
//
// Each patch must match the library source exactly. If the library changes,
// the build fails here instead of shipping a half-patched console.

const WIRE_START = "    inbound: function (mb)\n";
const WIRE_END = "    request: function(n)\n";

const WIRE_INBOUND = `    inbound: function (mb)
    {
        // Frames are kept as views and copied once per message.
        this.buffers.push(new Uint8Array(mb));
        this.have = (this.have || 0) + mb.byteLength;

        while (this.needed > 0 && this.have >= this.needed)
        {
            var n = this.needed;
            var head = this.buffers[0];
            var out;
            if (head.byteLength >= n)
            {
                out = head.subarray(0, n);
                if (head.byteLength > n)
                    this.buffers[0] = head.subarray(n);
                else
                    this.buffers.shift();
            }
            else
            {
                out = new Uint8Array(n);
                var at = 0;
                while (at < n)
                {
                    var b = this.buffers[0];
                    var take = Math.min(b.byteLength, n - at);
                    out.set(take === b.byteLength ? b : b.subarray(0, take), at);
                    at += take;
                    if (take === b.byteLength)
                        this.buffers.shift();
                    else
                        this.buffers[0] = b.subarray(take);
                }
            }
            this.have -= n;
            var ab = (out.byteOffset === 0 && out.byteLength === out.buffer.byteLength) ? out.buffer : out.slice().buffer;
            this.callback.call(this.sc, ab, this.saved_msg_header || undefined);
        }
    },

`;

const JPEG_HELPER = `
function spice_jpeg_src(img, data)
{
    var u = URL.createObjectURL(new Blob([data], { type: "image/jpeg" }));
    var done = function () { URL.revokeObjectURL(u); };
    img.addEventListener("load", done, { once: true });
    img.addEventListener("error", done, { once: true });
    img.src = u;
}
`;

// for (i = 0; i < X.length; i++) { tmpstr += '%'; if (X[i] < 16) tmpstr += '0'; tmpstr += X[i].toString(16); }
const JPEG_LOOP = /for \(i = 0; i < ([\w.]+)\.length; i\+\+\)\s*\{\s*tmpstr \+=\s*'%';\s*if \(\1\[i\] < 16\)\s*tmpstr \+= '0';\s*tmpstr \+= \1\[i\]\.toString\(16\);\s*\}/g;
const JPEG_SRC = /img\.src = tmpstr;/g;

function count(src, re) {
  return (src.match(re) || []).length;
}

export function patchWire(src) {
  const a = src.indexOf(WIRE_START);
  const b = src.indexOf(WIRE_END);
  if (a < 0 || b < a) throw new Error("spice-perf: wire.js did not match, check the spice-html5 version");
  return src.slice(0, a) + WIRE_INBOUND + src.slice(b);
}

export function patchDisplay(src) {
  if (count(src, JPEG_LOOP) !== 3 || count(src, JPEG_SRC) !== 3) {
    throw new Error("spice-perf: display.js did not match, check the spice-html5 version");
  }
  src = src.replace(JPEG_LOOP, "tmpstr = $1;").replace(JPEG_SRC, "spice_jpeg_src(img, tmpstr);");
  return src + JPEG_HELPER;
}

export default function spicePerf() {
  return {
    name: "spice-perf",
    enforce: "pre",
    transform(code, id) {
      const p = id.split("?")[0].replace(/\\/g, "/");
      if (!p.includes("/@spice-project/spice-html5/src/")) return null;
      if (p.endsWith("/wire.js")) return { code: patchWire(code), map: null };
      if (p.endsWith("/display.js")) return { code: patchDisplay(code), map: null };
      return null;
    },
  };
}
