// UX-A checks. Usage: BASE=https://127.0.0.1:8514 OUT=/tmp/claude-0/ws14 node ws14.spec.js
// Needs a running instance named w14-a (with a snapshot) and w14-b; admin / review-pass-2026.
const { chromium } = require("playwright");
const BASE = process.env.BASE || "https://127.0.0.1:8514";
const OUT = process.env.OUT || "/tmp/claude-0/ws14";
const ok = (c, m) => console.log((c ? "PASS " : "FAIL ") + m);

(async () => {
  const b = await chromium.launch();
  let ctx = await b.newContext({ ignoreHTTPSErrors: true });
  let p = await ctx.newPage();
  await p.goto(BASE + "/");
  await p.waitForSelector('input[type="password"]');
  await p.locator("input").first().fill("admin");
  await p.locator('input[type="password"]').fill("review-pass-2026");
  await p.keyboard.press("Enter");
  await p.waitForTimeout(2500);
  await ctx.storageState({ path: OUT + "/state.json" });
  await ctx.close();

  for (const [name, opts] of [
    ["desk", { viewport: { width: 1440, height: 900 } }],
    ["phone", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }],
  ]) {
    for (const scheme of name === "desk" ? ["light", "dark"] : ["light"]) {
      ctx = await b.newContext({ ignoreHTTPSErrors: true, storageState: OUT + "/state.json", colorScheme: scheme, ...opts });
      p = await ctx.newPage();
      const T = `${name}-${scheme}`;
      const shot = (n) => p.screenshot({ path: `${OUT}/${T}-${n}.png` });
      // 1 snapshot menu
      await p.goto(BASE + "/instances/vm/w14-a/snapshots");
      await p.waitForSelector("text=s1");
      await p.getByRole("button", { name: /More actions for s1/ }).click();
      await p.waitForTimeout(400);
      const mb = await p.locator(".menu").boundingBox();
      const tb = await p.locator(".tw-menu").boundingBox();
      ok(mb.y + mb.height > tb.y + tb.height, `${T} snapshot menu extends below table`);
      await shot("snap-menu");
      // 4 memory
      await p.goto(BASE + "/instances/vm/w14-a/configuration");
      const mem = p.getByLabel("Memory", { exact: true });
      await mem.waitFor();
      const unit = p.getByLabel("Memory unit");
      const v0 = await mem.inputValue(), u0 = await unit.inputValue();
      await unit.selectOption("GiB");
      ok((await mem.inputValue()) === "0.25", `${T} 256 MiB -> ${await mem.inputValue()} GiB (was ${v0} ${u0})`);
      await unit.selectOption("MiB");
      ok((await mem.inputValue()) === "256", `${T} back to 256 MiB`);
      // 6 ctrl+k
      await p.goto(BASE + "/instances");
      await p.waitForSelector("text=w14-a");
      await p.keyboard.press("Control+k");
      await p.waitForSelector(".cmdk-in input"); await p.locator(".cmdk-in input").fill("stop");
      await p.waitForTimeout(500);
      const first = await p.locator(".cmdk-i").first().innerText();
      ok(/^Stop|Force stop/.test(first.trim()), `${T} first cmdk result for "stop": ${first.replace(/\n/g, " | ")}`);
      if (name === "desk" && scheme === "light") {
        await p.locator(".cmdk-i", { hasText: "Stop w14-b" }).first().click();
        await p.waitForTimeout(500);
        ok(await p.getByText("Stop w14-b?").isVisible(), "stop confirm dialog shown");
        await shot("stop-confirm");
        await p.getByRole("button", { name: "Cancel" }).click();
      }
      // 10 profile preview
      await p.goto(BASE + "/instances");
      await p.waitForSelector("text=w14-a");
      await p.getByRole("button", { name: /^Profile/ }).click();
      const total = await p.locator(".fopt").first().click();
      const label = await p.locator(".ffoot .btn-p").innerText();
      const exp = await p.locator("tbody tr").count();
      await shot("profile-pop");
      console.log(`  ${T} profile first option -> "${label}" (rows now ${exp})`);
      await p.locator(".ffoot .btn-p").click();
      await p.waitForTimeout(400);
      const rows = await p.locator("tbody tr").count();
      ok(label.includes(String(rows)), `${T} profile Show N matches ${rows} rows`);
      await shot("inst-filtered");
      // 14 checkboxes
      if (name === "phone") {
        const cb = await p.locator("td.chk .chk-l").first().boundingBox();
        ok(cb.width >= 40 && cb.height >= 40, `checkbox hit area ${cb.width}x${cb.height}`);
        const sa = await p.locator("th.chk .chk-l").boundingBox();
        ok(sa.width >= 40 && sa.height >= 40, `select-all hit area ${sa.width}x${sa.height}`);
      }
      // 16 filter bar
      await p.goto(BASE + "/instances");
      await p.waitForSelector("text=w14-a");
      await shot("inst-list");
      if (name === "phone") {
        const sw = await p.evaluate(() => document.documentElement.scrollWidth);
        const r = await p.evaluate(() => [...document.querySelectorAll(".fbar button")].map((e) => Math.round(e.getBoundingClientRect().right)));
        ok(sw <= 390 && Math.max(...r) <= 390, `filter bar fits (scrollWidth ${sw}, max right ${Math.max(...r)})`);
      }
      // 18a chip
      await p.goto(BASE + "/instances?q=w14-a");
      await p.waitForSelector(".chip");
      const cb2 = await p.locator(".chip-b").boundingBox(), cx = await p.locator(".chip-x").boundingBox();
      ok(Math.abs(cb2.y + cb2.height / 2 - (cx.y + cx.height / 2)) < 3, `${T} chip text/x aligned`);
      await shot("chip");
      // 11 detail menu
      await p.goto(BASE + "/instances/vm/w14-a");
      await p.getByRole("button", { name: "More actions" }).click();
      await shot("detail-menu");
      ok(await p.locator(".menu-hint").count() === 1, `${T} menu hint shown`);
      await p.keyboard.press("Escape");
      // 9 overview
      await p.goto(BASE + "/");
      await p.waitForTimeout(2500);
      await shot("overview");
      if (name === "phone") {
        const t = await p.locator(".seg0 button").first().boundingBox();
        ok(t && t.height >= 40, `overview network tab height ${t && t.height}`);
      }
      // 13 sidebar
      if (name === "desk") await shot("sidebar");
      // create image rows
      await p.goto(BASE + "/instances?create=1");
      await p.waitForTimeout(1200);
      const io = p.locator(".iopt").first();
      if (await io.count()) {
        const h = (await io.boundingBox()).height;
        ok(name === "desk" || h >= 44, `${T} image row height ${h}`);
      } else console.log("  no .iopt rows visible");
      await ctx.close();
    }
  }
  await b.close();
})();
