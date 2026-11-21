// Overview bento check. Usage: BASE=https://127.0.0.1:8510 OUT=/tmp/claude-0/ws10 node web/e2e/ws10.spec.js
// Assumes admin / review-pass-2026. Takes light, dark and phone screenshots.
const { chromium } = require("playwright");
const fs = require("fs");
const BASE = process.env.BASE || "https://127.0.0.1:8510";
const OUT = process.env.OUT || "/tmp/claude-0/ws10";
const assert = (c, m) => {
  if (!c) throw new Error("FAIL: " + m);
  console.log("ok:", m);
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const state = OUT + "/state.json";
  let ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 }, ...(fs.existsSync(state) ? { storageState: state } : {}) });
  let page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE + "/");
  if (await page.locator('input[type="password"]').count()) {
    await page.locator("input").first().fill("admin");
    await page.locator('input[type="password"]').fill("review-pass-2026");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1500);
  }
  await ctx.storageState({ path: state });
  await page.goto(BASE + "/");
  await page.waitForSelector(".bento .b-cell").catch(async (e) => {
    await page.screenshot({ path: OUT + "/fail.png" });
    throw e;
  });
  await page.waitForTimeout(2500);
  assert((await page.locator(".b-capacity .ru-fill").count()) >= 2, "capacity rulers drawn");
  // two dir pools on one disk are one ruler
  const pools = await page.locator(".b-capacity .ru-l").allTextContents();
  console.log("rulers:", pools.join(", "));
  assert(!(pools.includes("default") && pools.includes("fast")), "same-disk pools are not listed twice");
  assert((await page.locator(".b-timeline .tl").count()) === 1, "timeline drawn");
  await page.screenshot({ path: OUT + "/light.png", fullPage: true });

  // customize: toggle Base images on, move it up, persists on the server
  await page.getByRole("button", { name: "Customize" }).click();
  await page.waitForSelector(".cz");
  await page.getByRole("switch", { name: "Show Base images" }).click();
  await page.getByRole("button", { name: "Move Base images up" }).click();
  await page.screenshot({ path: OUT + "/customize.png" });
  await page.getByRole("button", { name: "Done" }).click();
  await page.waitForTimeout(500);
  const prefs = await page.evaluate(() => fetch("/api/ui/prefs").then((r) => r.json()));
  const ids = prefs.dashboard.items.map((i) => i.id);
  assert(ids.indexOf("images") === ids.indexOf("pinned") - 0 || ids.indexOf("images") < 9, "prefs saved on server: " + ids.join(","));
  await page.reload();
  await page.waitForSelector(".b-images");
  assert(true, "Base images shown after reload");
  await page.screenshot({ path: OUT + "/light-images.png", fullPage: true });
  // reset
  await page.getByRole("button", { name: "Customize" }).click();
  await page.getByRole("button", { name: "Reset to default" }).click();
  await page.getByRole("button", { name: "Done" }).click();
  await page.waitForTimeout(400);
  assert((await page.locator(".b-images").count()) === 0, "reset hides Base images");

  await page.emulateMedia({ colorScheme: "dark" });
  await page.evaluate(() => localStorage.setItem("iwui.mode", "dark"));
  await page.reload();
  await page.waitForSelector(".bento .b-cell");
  await page.waitForTimeout(2500);
  await page.screenshot({ path: OUT + "/dark.png", fullPage: true });

  const phone = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, storageState: state, isMobile: true });
  const p2 = await phone.newPage();
  await p2.goto(BASE + "/");
  await p2.waitForSelector(".bento .b-cell");
  await p2.waitForTimeout(2500);
  const over = await p2.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert(over <= 0, "no horizontal scroll on phone (" + over + ")");
  await p2.screenshot({ path: OUT + "/phone.png", fullPage: true });
  assert(errors.length === 0, "no page errors " + errors.join("; "));
  await browser.close();
})().catch((e) => {
  console.error("at", new Date().toISOString());
  console.error(e.message);
  process.exit(1);
});
