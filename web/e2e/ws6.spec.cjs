// WS6 check: operations, warnings, command menu, host page, phone sidebar.
// Usage: BASE=https://127.0.0.1:8506 node web/e2e/ws6.spec.js   (needs playwright, admin/review-pass-2026,
// and instances w6-box (running) and w6-stopped (stopped) in project default)
const { chromium } = require("playwright");
const { execSync } = require("child_process");
const BASE = process.env.BASE || "https://127.0.0.1:8506";
const OUT = process.env.OUT || "/tmp/claude-0/ws6";
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };
const sh = (c) => execSync(c, { encoding: "utf8" }).trim();

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(BASE);
  if (await page.locator('input[type="password"]').count()) {
    await page.locator("input").first().fill("admin");
    await page.locator('input[type="password"]').fill("review-pass-2026");
    await page.keyboard.press("Enter");
  }
  await page.waitForSelector(".side");

  // --- Warnings ---
  await page.goto(BASE + "/warnings");
  await page.waitForSelector("tbody tr");
  await page.locator(".seg button", { hasText: /^All/ }).click();
  ok(await page.locator("th", { hasText: "Status" }).count() > 0, "All tab shows a Status column");
  const first = page.locator("tbody tr").first();
  await first.getByRole("button", { name: "Acknowledge" }).click();
  await page.waitForTimeout(1200);
  const reopen = page.getByRole("button", { name: "Mark as new" }).first();
  ok(await reopen.count() > 0, "acknowledged warning offers Mark as new");
  await page.screenshot({ path: OUT + "/warnings-all.png" });
  await reopen.click();
  await page.waitForTimeout(1200);
  ok(sh("incus warning list --format csv").split("\n").every((l) => /new/i.test(l)), "all warnings are new again on the server");
  await page.waitForTimeout(1500);
  await page.locator("tbody tr").first().getByRole("button", { name: "Delete warning" }).click();
  await page.waitForTimeout(400);
  ok(await page.getByText("Delete this warning?").count() > 0, "delete asks for confirmation");
  await page.screenshot({ path: OUT + "/warnings-confirm.png" });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  ok(sh("incus warning list --format csv | wc -l") === "3", "warning still there after cancelling");

  // --- Operations ---
  const bg = require("child_process").spawn("incus", ["init", "ubuntu/24.04", "w6-ops"], { stdio: "ignore" });
  await page.goto(BASE + "/operations");
  await page.waitForTimeout(1500);
  const opsText = await page.locator("tbody").innerText();
  ok(!/ago ago|just now ago/.test(opsText), "no 'just now ago'");
  ok(!/instances? \S+, instances? \S+/.test(opsText), "resource text not duplicated");
  await page.screenshot({ path: OUT + "/operations.png" });
  await new Promise((r) => bg.on("exit", r));
  sh("incus delete -f w6-ops");

  // --- Command menu ---
  await page.goto(BASE + "/");
  await page.waitForSelector(".side");
  await page.keyboard.press("Control+k");
  await page.waitForSelector(".cmdk-list");
  await page.waitForTimeout(800);
  for (let i = 0; i < 30; i++) await page.keyboard.press("ArrowDown");
  const vis = await page.evaluate(() => {
    const l = document.querySelector(".cmdk-list"), s = document.querySelector('.cmdk-i[aria-selected="true"]');
    const a = l.getBoundingClientRect(), b = s.getBoundingClientRect();
    return b.top >= a.top - 1 && b.bottom <= a.bottom + 1 && l.scrollTop > 0;
  });
  ok(vis, "selected row stays visible and list scrolls with arrows");
  await page.screenshot({ path: OUT + "/cmdk-scrolled.png" });
  const find = async (q, want) => {
    await page.locator(".cmdk-in input").fill(q);
    await page.waitForTimeout(200);
    const t = await page.locator(".cmdk-list").innerText();
    ok(want.every((w) => t.includes(w)), `search "${q}" finds ${want.join(", ")}`);
    return t;
  };
  await find("incusbr", ["incusbr0", "Networks"]);
  await find("fast", ["fast", "Storage pools"]);
  await find("default", ["Profiles", "Projects"]);
  await find("busybox", ["Images"]);
  await find("api-dev", ["api-dev", "dev"]);
  await page.screenshot({ path: OUT + "/cmdk-search.png" });
  await find("restart w6-box", ["Restart w6-box"]);
  await find("start w6-stopped", ["Start w6-stopped"]);
  await find("terminal w6-box", ["Open terminal in w6-box"]);
  await page.locator(".cmdk-in input").fill("stop w6-box");
  await page.waitForTimeout(200);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(4000);
  ok(/STOPPED/.test(sh("incus list w6-box -c s --format csv").toUpperCase()), "Stop from menu stops w6-box");
  sh("incus start w6-box");
  await page.keyboard.press("Control+k");
  await page.locator(".cmdk-in input").fill("incusbr0");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  ok(page.url().endsWith("/networks"), "network result navigates to /networks");

  // --- Host ---
  await page.goto(BASE + "/hosts/vm");
  await page.getByText("Incus running for").waitFor({ timeout: 20000 }).catch(() => {});
  const ht = await page.locator(".dgrid").innerText();
  ok(/Incus running for/.test(ht), "host shows uptime");
  ok(/eth0/.test(ht) && /192\.0\.2\.2/.test(ht), "host shows NIC address");
  ok(/used of/.test(ht) && /default/.test(ht), "host shows pools used/total");
  ok(await page.locator('.hostlist a[href*="w6-box"]').count() > 0 || /Show all/.test(ht), "host lists instances with link");
  await page.screenshot({ path: OUT + "/host.png", fullPage: true });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: OUT + "/host-dark.png", fullPage: true });

  // --- Phone ---
  const ph = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 640 }, storageState: await ctx.storageState(), hasTouch: true });
  const p = await ph.newPage();
  await p.goto(BASE + "/");
  await p.waitForSelector(".menu-btn");
  await p.click(".menu-btn");
  await p.waitForTimeout(500);
  await p.screenshot({ path: OUT + "/phone-drawer.png" });
  const small = await p.evaluate(() => [...document.querySelectorAll(".side .ni")].filter((e) => e.getBoundingClientRect().height && e.getBoundingClientRect().height < 36).length);
  ok(small === 0, "drawer targets are tall enough");
  await p.evaluate(() => { const n = document.querySelector(".side .nav"); n.scrollTop = n.scrollHeight; });
  await p.waitForTimeout(300);
  const warnLink = p.locator('.side a[href="/warnings"]');
  const hid = await p.evaluate(() => { const a = document.querySelector('.side a[href="/warnings"]').getBoundingClientRect(), f = document.querySelector(".side-foot").getBoundingClientRect(); return a.bottom > f.top + 1; });
  ok(!hid, "Warnings item sits above the footer after scrolling");
  await p.screenshot({ path: OUT + "/phone-drawer-end.png" });
  await warnLink.click();
  await p.waitForTimeout(800);
  ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no horizontal scroll on phone warnings");
  await p.goto(BASE + "/operations");
  await p.waitForTimeout(800);
  ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no horizontal scroll on phone operations");
  await p.goto(BASE + "/hosts/vm");
  await p.waitForTimeout(2000);
  ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no horizontal scroll on phone host");
  await p.screenshot({ path: OUT + "/phone-host.png", fullPage: true });
  await p.keyboard.press("Control+k");
  await p.waitForTimeout(600);
  await p.screenshot({ path: OUT + "/phone-cmdk.png" });
  await browser.close();
})();
