// Fails the build when a stylesheet has unbalanced braces (ignores comments and strings).
const fs = require("fs");
const path = require("path");

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : p.endsWith(".css") ? [p] : [];
  });
}

let bad = 0;
for (const f of walk(path.join(__dirname, "..", "src"))) {
  const s = fs.readFileSync(f, "utf8");
  const rel = path.relative(process.cwd(), f);
  let depth = 0;
  let line = 1;
  let first = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\n") line++;
    else if (c === "/" && s[i + 1] === "*") {
      const j = s.indexOf("*/", i + 2);
      const end = j < 0 ? s.length : j + 2;
      line += s.slice(i, end).split("\n").length - 1;
      i = end - 1;
    } else if (c === '"' || c === "'") {
      for (i++; i < s.length && s[i] !== c && s[i] !== "\n"; i++) if (s[i] === "\\") i++;
    } else if (c === "{") {
      if (depth++ === 0) first = line;
    } else if (c === "}" && --depth < 0) {
      console.error(`${rel}:${line}: unexpected }`);
      bad++;
      depth = 0;
    }
  }
  if (depth > 0) {
    console.error(`${rel}: ${depth} unclosed { (outermost opened at line ${first})`);
    bad++;
  }
}
process.exit(bad ? 1 : 0);
