// WS2 checks: instance list + detail. Run: BASE=https://127.0.0.1:8502 node web/e2e/ws2.spec.js
// Needs playwright, a signed-in storage state (STATE, default /tmp/claude-0/ws2/state.json) and
// instances w2-a (running), w2-b (frozen), w2-c (stopped) in the default project.
const { chromium } = require("playwright");
const { execSync } = require("child_process");
const BASE = process.env.BASE || "https://127.0.0.1:8502";
const STATE = process.env.STATE || "/tmp/claude-0/ws2/state.json";
const OUT = process.env.OUT || "/tmp/claude-0/ws2";
const sh = (c) => execSync(c, { encoding: "utf8" }).trim();
const st = (n, p = "default") => sh(`incus list ${n} --project ${p} -f csv -c s`).split("\n")[0];
let fails = 0;
const ok = (c, m) => (console.log((c ? "PASS " : "FAIL ") + m), c || fails++);

(async () => {
  const b = await chromium.launch();
  const c = await b.newContext({ ignoreHTTPSErrors: true, storageState: STATE, viewport: { width: 1280, height: 800 } });
  
  await c.addInitScript(() => localStorage.setItem("iwui.project", "default"));
  const p = await c.newPage();
  const toast = async () => (await p.locator(".toast").last().innerText()).trim();

  // 1+2: frozen row offers Resume, no Start; bulk skips and reports
  await p.goto(BASE + "/instances?q=w2-");
  await p.waitForSelector("tr:has-text('w2-b')");
  const rowB = p.locator("tr:has-text('w2-b')");
  ok((await rowB.locator("button[aria-label=Resume]").count()) === 1 && (await rowB.locator("button[aria-label=Start]").count()) === 0, "frozen row shows Resume, not Start");
  await p.locator("tr:has-text('w2-a') input[type=checkbox]").check();
  await p.locator("tr:has-text('w2-c') input[type=checkbox]").check();
  await p.locator("tr:has-text('w2-b') input[type=checkbox]").check();
  ok(await p.locator(".bulk button:has-text('Resume')").isEnabled(), "bulk Resume enabled with a frozen one selected");
  await p.locator('.bulk').getByRole('button', { name: 'Start', exact: true }).click();
  await p.waitForSelector(".toast:has-text('skipped')");
  console.log("  toast:", await toast());
  ok(/Started 1, skipped 2/.test(await toast()), "bulk start reports skipped");
  await p.screenshot({ path: OUT + "/bulk.png" });
  await p.waitForTimeout(4000);
  // stop via bulk with confirm (c now running, a running, b frozen)
  await p.locator(".bulk button:has-text('Stop')").click();
  await p.waitForSelector(".dlg:has-text('Stop 3 instances')");
  await p.screenshot({ path: OUT + "/stopdlg.png" });
  await p.locator(".dlg button[type=submit]").click();
  await p.waitForSelector(".toast:has-text('Stopped')");
  console.log("  toast:", await toast());
  await p.waitForTimeout(2500);
  ok(["STOPPED"].includes(st("w2-b")) && st("w2-a") === "STOPPED", "frozen instance force stopped from bulk");
  // bulk Stop is disabled when everything is stopped
  ok(await p.locator(".bulk button:has-text('Stop')").isDisabled(), "bulk Stop disabled when none apply");

  // 3: row stop confirm
  sh("incus start w2-a");
  await p.waitForTimeout(5500);
  await p.locator("tr:has-text('w2-a') button[aria-label=Stop]").click();
  await p.waitForSelector(".dlg:has-text('Stop w2-a?')");
  ok(await p.locator(".dlg:has-text('Force stop')").count() > 0, "stop confirm offers Force stop");
  await p.locator(".dlg button:has-text('Cancel')").click();
  ok(st("w2-a") === "RUNNING", "cancel keeps it running");

  // 5: URL state
  await p.goto(BASE + "/instances");
  await p.fill(".fsearch input", "w2-");
  await p.waitForTimeout(300);
  ok(p.url().includes("q=w2-"), "search in URL");
  await p.locator("th button:has-text('State')").click();
  ok(p.url().includes("sort=status"), "sort in URL");
  await p.locator("tr:has-text('w2-a')").first().click();
  await p.waitForURL(/instances\/vm\/w2-a/);
  await p.goBack();
  await p.waitForSelector("tr:has-text('w2-a')");
  ok((await p.inputValue(".fsearch input")) === "w2-" && p.url().includes("sort=status"), "filters survive back navigation");
  await p.goto(BASE + "/instances?profile=small");
  await p.waitForTimeout(1500);
  ok((await p.locator("tbody").innerText()).includes("db1") && !(await p.locator("tbody").innerText()).includes("app1"), "profile filter from URL");
  // 4: bulk delete needs the typed phrase for more than one
  sh("incus init busybox w2-d1"); sh("incus init busybox w2-d2");
  await p.goto(BASE + "/instances?q=w2-d");
  await p.waitForSelector("tr:has-text('w2-d2')");
  await p.locator("th.chk input").check();
  await p.locator(".bulk button:has-text('Delete')").click();
  const del = p.locator(".dlg button.btn-d");
  ok(await del.isDisabled(), "bulk delete disabled until phrase typed");
  await p.fill(".dlg input", "delete 2");
  await del.click();
  await p.waitForSelector(".toast:has-text('Deleted 2')");
  ok(sh("incus list w2-d -f csv -c n") === "", "bulk delete removed both");
  await b.close();
  console.log(fails ? `${fails} FAILED` : "ALL PASSED");
  process.exit(fails ? 1 : 0);
})();
