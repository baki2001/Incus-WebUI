const { chromium } = require("playwright");
const BASE = process.env.BASE || "https://127.0.0.1:8515";
async function login() {
  const b = await chromium.launch();
  const ctx = await b.newContext({ ignoreHTTPSErrors: true });
  const p = await ctx.newPage();
  await p.goto(BASE + "/");
  await p.waitForSelector('input[type="password"]');
  await p.locator("input").first().fill("admin");
  await p.locator('input[type="password"]').fill("review-pass-2026");
  await p.keyboard.press("Enter");
  await p.waitForTimeout(2500);
  await ctx.storageState({ path: "/tmp/state.json" });
  await b.close();
}
async function mk(b, mode) {
  const opts = { ignoreHTTPSErrors: true, storageState: "/tmp/state.json" };
  if (mode === "phone") Object.assign(opts, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme: "light" });
  else Object.assign(opts, { viewport: { width: 1440, height: 900 }, colorScheme: mode });
  const ctx = await b.newContext(opts);
  const p = await ctx.newPage();
  return { ctx, p };
}
module.exports = { chromium, BASE, login, mk };
