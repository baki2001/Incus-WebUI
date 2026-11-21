// WS1 checks: node web/e2e/ws1.spec.js   (BASE=https://127.0.0.1:8501, admin / review-pass-2026)
// Needs playwright (NODE_PATH=$(npm root -g)). Uses throwaway users named w1-*.
const { chromium } = require("playwright");
const https = require("https");
const BASE = process.env.BASE || "https://127.0.0.1:8501";
const OUT = process.env.OUT || "/tmp/claude-0/ws1";
const PASS = "review-pass-2026";
let failed = 0;
const ok = (c, m) => {
  console.log((c ? "PASS " : "FAIL ") + m);
  if (!c) failed++;
};

function api(method, path, body, cookie, ip) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request(BASE + path, { method, rejectUnauthorized: false, headers: { "X-Incus-UI": "1", "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(ip ? { "X-Forwarded-For": ip } : {}) } }, (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => resolve({ status: res.statusCode, body: b, cookie: (res.headers["set-cookie"] || []).map((c) => c.split(";")[0]).find((c) => c.startsWith("iwui_session=") && c.length > 15) }));
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  // 1. logout revokes the session on the server
  const a = await api("POST", "/api/ui/login", { username: "admin", password: PASS });
  ok(a.status === 200 && a.cookie, "login works");
  ok((await api("GET", "/api/ui/users", null, a.cookie)).status === 200, "session works before logout");
  await api("POST", "/api/ui/logout", null, a.cookie);
  ok((await api("GET", "/api/ui/users", null, a.cookie)).status === 401, "old cookie rejected after logout");

  // 2. rate limit: failures for admin do not stop a correct login (same IP here, so use another username)
  const s = await api("POST", "/api/ui/login", { username: "admin", password: PASS });
  const cookie = s.cookie;
  for (let i = 0; i < 7; i++) await api("POST", "/api/ui/login", { username: "nobody-w1", password: "x" });
  const locked = await api("POST", "/api/ui/login", { username: "nobody-w1", password: "x" });
  ok(locked.status === 429, "repeated failures for one username lock that username+IP");
  const other = await api("POST", "/api/ui/login", { username: "admin", password: PASS });
  ok(other.status === 200, "correct admin login still works from the same IP");

  // 4. user rules via API
  ok((await api("POST", "/api/ui/users", { username: "w1-bob", password: "bob-password-1" }, cookie)).status === 204, "add user");
  const dup = await api("POST", "/api/ui/users", { username: "w1-bob", password: "other-password-2" }, cookie);
  ok(dup.status === 409, "adding an existing username is refused");
  ok((await api("DELETE", "/api/ui/users/admin", null, cookie)).status === 400, "cannot remove own account");

  // 3 + 4 + 5 in the browser
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(BASE + "/instances/vm/db1");
  await page.fill("#u", "admin");
  await page.fill("#p", PASS);
  await page.click("button.btn-p");
  await page.waitForSelector(".av, nav", { timeout: 10000 });
  ok(new URL(page.url()).pathname === "/instances/vm/db1", "returns to the page that was opened: " + page.url());
  await ctx.storageState({ path: OUT + "/state.json" });

  // open redirect attempt
  const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
  const p2 = await ctx2.newPage();
  await p2.goto(BASE + "//example.com/x");
  await p2.fill("#u", "admin");
  await p2.fill("#p", PASS);
  await p2.click("button.btn-p");
  await p2.waitForSelector("nav");
  ok(new URL(p2.url()).origin === new URL(BASE).origin && new URL(p2.url()).pathname === "/", "protocol-relative path falls back to /: " + p2.url());
  await ctx2.close();

  await page.goto(BASE + "/settings/users");
  await page.waitForSelector("text=Local users");
  ok((await page.locator(".snap", { hasText: "admin" }).getByText("Remove").count()) === 0, "no Remove button on your own row");
  await page.fill('input[autocomplete="off"]', "w1-bob");
  await page.fill('input[autocomplete="new-password"]', "whatever-pass-123");
  await page.click("text=Add user");
  await page.waitForSelector("text=already exists");
  ok(true, "UI shows duplicate error");
  await page.screenshot({ path: OUT + "/users-light.png" });
  await page.locator(".snap", { hasText: "w1-bob" }).getByText("Change password").click();
  await page.fill('.snap input[type="password"]', "bob-new-password-9");
  await page.screenshot({ path: OUT + "/users-changepw.png" });
  await page.locator(".snap form").getByText("Save").click();
  await page.waitForSelector("text=Password changed for w1-bob");
  const bobLogin = await api("POST", "/api/ui/login", { username: "w1-bob", password: "bob-new-password-9" });
  ok(bobLogin.status === 200, "new password works");
  await api("DELETE", "/api/ui/users/w1-bob", null, cookie);

  await page.goto(BASE + "/settings/about");
  await page.click("text=Check now");
  await page.waitForSelector('p[role="status"]:has-text("Checking")', { timeout: 3000 }).catch(() => {});
  await page.waitForSelector('p[role="status"]:has-text("Up to date"), p[role="status"]:has-text("available"), p[role="status"]:has-text("check for updates")', { timeout: 30000 });
  const txt = await page.locator('p[role="status"]').innerText();
  ok(txt.length > 0, "update check shows a result: " + txt);
  await page.screenshot({ path: OUT + "/updates.png" });

  const phone = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 800 }, storageState: OUT + "/state.json" });
  const pp = await phone.newPage();
  await pp.goto(BASE + "/settings/users");
  await pp.waitForSelector("text=Local users");
  await pp.locator(".snap", { hasText: "admin" }).getByText("Change password").click();
  await pp.screenshot({ path: OUT + "/users-phone.png" });
  ok((await pp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)), "no horizontal scroll at 390px");
  await browser.close();
  console.log(failed ? failed + " FAILED" : "ALL OK");
  process.exit(failed ? 1 : 0);
})();
