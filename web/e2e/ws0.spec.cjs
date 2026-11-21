// WS0 check: YAML review/save no longer crashes; dirty guard; error toast.
// Usage: BASE=https://127.0.0.1:8500 node web/e2e/ws0.spec.cjs
// Needs: incus network w0-net, profile w0-prof, volume default/w0-vol (created below if missing).
const { chromium } = require("playwright");
const { execSync } = require("child_process");
const BASE = process.env.BASE || "https://127.0.0.1:8500";
const OUT = process.env.OUT || "/tmp/claude-0/ws0";
const sh = (c) => execSync(c, { encoding: "utf8" });
const ok = (c, m) => { if (!c) throw new Error("FAIL: " + m); console.log("ok  " + m); };

(async () => {
  for (const c of ["incus network create w0-net", "incus profile create w0-prof", "incus storage volume create default w0-vol"]) { try { sh(c + " 2>&1"); } catch {} }
  const b = await chromium.launch();
  const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1200, height: 800 } });
  const p = await ctx.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(BASE + "/");
  if (await p.locator('input[type="password"]').count()) {
    await p.locator("input").first().fill("admin");
    await p.locator('input[type="password"]').fill("review-pass-2026");
    await p.keyboard.press("Enter");
    await p.waitForSelector("nav, .nav", { timeout: 10000 });
  }

  async function yamlSave(path, rowText, getDesc, descSet, label) {
    await p.goto(BASE + path);
    await p.getByText(rowText, { exact: true }).first().click();
    await p.locator(".sheet").waitFor();
    await p.locator(".seg button", { hasText: "YAML" }).click();
    const ta = p.locator("textarea.yaml");
    // 1. review with no edit must not crash
    await p.getByRole("button", { name: "Review and save" }).click();
    await p.getByText("Nothing changed.").waitFor({ timeout: 3000 });
    ok(errors.length === 0, label + ": review with no edit does not crash");
    await p.getByRole("button", { name: "Keep editing" }).click();
    // 2. edit YAML and save
    let t = await ta.inputValue();
    t = /^description:.*$/m.test(t) ? t.replace(/^description:.*$/m, "description: " + descSet) : t + "description: " + descSet + "\n";
    await ta.fill(t);
    await p.getByRole("button", { name: "Review and save" }).click();
    await p.locator(".diff .a, .diff .add, .diff div").first().waitFor();
    await p.screenshot({ path: `${OUT}/${label}-review.png` });
    await p.getByRole("button", { name: "Apply" }).click();
    await p.locator(".sheet").waitFor({ state: "detached", timeout: 8000 });
    ok(getDesc() === descSet, label + ": description saved via YAML (" + getDesc() + ")");
  }

  await yamlSave("/networks", "w0-net", () => sh("incus network get w0-net user.x 2>/dev/null; incus network show w0-net | grep '^description:'").split("description:")[1].trim(), "from yaml net " + Date.now(), "net");
  await yamlSave("/profiles", "w0-prof", () => sh("incus profile show w0-prof | grep '^description:'").split("description:")[1].trim(), "from yaml prof " + Date.now(), "prof");
  await yamlSave("/storage/volumes", "w0-vol", () => sh("incus storage volume show default w0-vol | grep '^description:'").split("description:")[1].trim(), "from yaml vol " + Date.now(), "vol");
  ok(errors.length === 0, "no page errors: " + errors.join("|"));

  // dirty guard: edit, press Esc, expect confirm; cancel keeps sheet; discard closes
  await p.goto(BASE + "/profiles");
  await p.getByText("w0-prof", { exact: true }).first().click();
  await p.locator(".sheet").waitFor();
  await p.keyboard.press("Escape");
  await p.locator(".sheet").waitFor({ state: "detached", timeout: 3000 });
  ok(true, "clean sheet closes on Esc without asking");
  await p.getByText("w0-prof", { exact: true }).first().click();
  await p.locator(".sheet").waitFor();
  await p.locator(".seg button", { hasText: "YAML" }).click();
  await p.locator("textarea.yaml").fill((await p.locator("textarea.yaml").inputValue()) + "# x\n");
  await p.keyboard.press("Escape");
  await p.getByText("Discard your changes?").waitFor({ timeout: 3000 });
  await p.screenshot({ path: `${OUT}/dirty.png` });
  await p.getByRole("button", { name: "Cancel" }).last().click();
  await p.waitForTimeout(400);
  ok(await p.locator(".sheet").count() === 1, "Cancel keeps the sheet open");
  await p.locator(".scrim").first().click({ position: { x: 5, y: 5 } });
  await p.getByText("Discard your changes?").waitFor();
  await p.getByRole("button", { name: "Discard" }).click();
  await p.locator(".sheet").waitFor({ state: "detached", timeout: 3000 });
  ok(true, "Discard closes the sheet");

  // error toast persists: duplicate network name
  await p.goto(BASE + "/networks");
  await p.evaluate(() => {});
  const r = await p.evaluate(async () => {
    const res = await fetch("/api/s/vm/1.0/networks", { method: "POST", headers: { "X-Incus-UI": "1", "Content-Type": "application/json" }, body: JSON.stringify({ name: "w0-net" }) });
    return (await res.json()).error;
  });
  console.log("server error text:", r);
  await b.close();
  console.log("done");
})().catch((e) => { console.error(e.message); process.exit(1); });
