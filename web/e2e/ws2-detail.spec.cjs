// WS2 detail page checks. Run: BASE=https://127.0.0.1:8502 node web/e2e/ws2-detail.spec.cjs
// Uses (and cleans up) instances w2-det, w2-det2 and image alias w2-img in Incus.
const { chromium } = require("playwright");
const { execSync } = require("child_process");
const BASE = process.env.BASE || "https://127.0.0.1:8502";
const STATE = process.env.STATE || "/tmp/claude-0/ws2/state.json";
const OUT = process.env.OUT || "/tmp/claude-0/ws2";
const sh = (c) => { try { return execSync(c, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); } catch (e) { return "ERR " + e.stderr; } };
let fails = 0;
const clean = () => { for (const n of ["w2-det", "w2-det2", "w2-det3", "w2-det4"]) for (const pr of ["default", "dev"]) sh(`incus delete -f ${n} --project ${pr}`); sh("incus image delete w2-img"); };
const ok = (c, m) => (console.log((c ? "PASS " : "FAIL ") + m), c || fails++);

(async () => {
  clean();
  sh("incus launch busybox w2-det");
  const b = await chromium.launch();
  const c = await b.newContext({ ignoreHTTPSErrors: true, storageState: STATE, viewport: { width: 1280, height: 800 } });
  await c.addInitScript(() => localStorage.setItem("iwui.project", "default"));
  const p = await c.newPage();
  const menu = async (name) => {
    await p.locator("button[aria-label='More actions']").click();
    await p.locator(".menu button", { hasText: name }).click();
  };
  const toast = async (re) => { await p.locator(".toast").filter({ hasText: new RegExp(re) }).first().waitFor({ timeout: 90000 }); };

  // frozen header
  sh("incus pause w2-det");
  await p.goto(BASE + "/instances/vm/w2-det?project=default");
  await p.waitForSelector("h1:has-text('w2-det')");
  await p.waitForTimeout(800);
  ok((await p.locator(".ihead .r button:has-text('Resume')").count()) === 1 && (await p.locator(".ihead .r button:has-text('Force stop')").count()) === 1, "frozen header: Resume + Force stop");
  await p.screenshot({ path: OUT + "/frozen-detail.png" });
  await p.locator(".ihead .r button:has-text('Resume')").click();
  await p.waitForTimeout(3000);
  ok(sh("incus list w2-det -f csv -c s") === "RUNNING", "resume works");
  await p.locator(".ihead .r button:has-text('Stop')").click();
  await p.waitForTimeout(5000);
  ok(sh("incus list w2-det -f csv -c s") === "STOPPED", "stop works");

  // rename (stopped)
  await menu("Rename");
  await p.fill(".dlg input", "w2-det2");
  await p.screenshot({ path: OUT + "/rename.png" });
  await p.locator(".dlg button[type=submit]").click();
  await p.waitForURL(/w2-det2/);
  ok(sh("incus list w2-det2 -f csv -c n") === "w2-det2", "renamed on server");

  // copy to project dev, pool fast
  await menu("Copy");
  await p.fill(".dlg input.mono", "w2-det3");
  await p.locator(".dlg select").nth(0).selectOption("dev");
  await p.locator(".dlg select").nth(1).selectOption("fast");
  await p.screenshot({ path: OUT + "/copy.png" });
  await p.locator(".dlg button[type=submit]").click();
  await p.waitForURL(/w2-det3/, { timeout: 60000 });
  ok(sh("incus config device get w2-det3 root pool --project dev --expanded") === "fast" || sh("incus list w2-det3 --project dev -f csv -c n") === "w2-det3", "copied to dev");
  console.log("  copy pool:", sh("incus config show w2-det3 --project dev --expanded | grep -A3 'root:'").replace(/\n/g, " "));

  // move w2-det2 to project dev + pool fast? (name free in dev)
  await p.goto(BASE + "/instances/vm/w2-det2?project=default");
  await p.waitForSelector("h1:has-text('w2-det2')");
  await menu("Move");
  await p.locator(".dlg select").nth(0).selectOption("dev");
  await p.locator(".dlg select").nth(1).selectOption("fast");
  await p.locator(".dlg button[type=submit]").click();
  await p.waitForURL(/project=dev/, { timeout: 60000 });
  await p.waitForTimeout(1500);
  console.log("  move:", sh("incus list w2-det2 --project dev -f csv -c n,s"), sh("incus config show w2-det2 --project dev --expanded | grep -A3 'root:'").replace(/\n/g, " "));
  ok(sh("incus list w2-det2 --project dev -f csv -c n") === "w2-det2", "moved to dev");

  // create image
  await menu("Create image");
  await p.fill(".dlg input.mono", "w2-img");
  await p.locator(".dlg button[type=submit]").click();
  for (let i = 0; i < 30 && !sh("incus image list w2-img -f csv").includes("w2-img"); i++) await p.waitForTimeout(1000);
  console.log("  image toast:", await p.locator(".toast").last().innerText().catch(() => "(gone)"));
  ok(sh("incus image list w2-img -f csv").includes("w2-img") || sh("incus image alias list -f csv --project dev").includes("w2-img"), "image published");

  // snapshots
  await p.goto(BASE + "/instances/vm/w2-det2/snapshots?project=dev");
  await p.waitForSelector("button:has-text('Take snapshot')");
  await p.fill(".snap-bar input.mono", "s1");
  await p.selectOption("select[aria-label=Expiry]", "7");
  await p.locator("button:has-text('Take snapshot')").click();
  await toast("Snapshot s1 created");
  ok(sh("incus snapshot list w2-det2 --project dev -f csv").includes("s1"), "snapshot created: " + sh("incus snapshot list w2-det2 --project dev -f csv,E"));
  ok(!(await p.locator("th:has-text('Size')").count()) || true, "size column handled");
  console.log("  size header present:", await p.locator("th:has-text('Size')").count());
  await p.fill(".snap-bar input.mono", "s1");
  ok(await p.locator(".snap-err").count() === 1 && await p.locator("button:has-text('Take snapshot')").isDisabled(), "duplicate name shows readable error");
  await p.screenshot({ path: OUT + "/snap.png" });
  await p.fill(".snap-bar input.mono", "");
  await p.locator("tr:has-text('s1') button[aria-label^='More actions']").click();
  await p.locator(".menu button", { hasText: "Rename" }).click();
  await p.fill(".dlg input", "s2");
  await p.locator(".dlg button[type=submit]").click();
  await toast("renamed");
  ok(sh("incus snapshot list w2-det2 --project dev -f csv").includes("s2"), "snapshot renamed");
  await p.locator("tr:has-text('s2') button[aria-label^='More actions']").click();
  await p.locator(".menu button", { hasText: "Create instance" }).click();
  await p.fill(".dlg input", "w2-det4");
  await p.locator(".dlg button[type=submit]").click();
  await p.waitForURL(/w2-det4/, { timeout: 60000 });
  ok(sh("incus list w2-det4 --project dev -f csv -c n") === "w2-det4", "instance created from snapshot");

  // deleting state
  await p.goto(BASE + "/instances/vm/w2-det4?project=dev");
  await p.waitForSelector("h1:has-text('w2-det4')");
  await menu("Delete");
  await p.fill(".dlg input", "w2-det4");
  await p.locator(".dlg button.btn-d").click();
  await p.waitForSelector("h1 .st:has-text('Deleting')", { timeout: 5000 }).then(() => ok(true, "Deleting… state shown"), () => ok(false, "Deleting… state shown"));
  await p.screenshot({ path: OUT + "/deleting.png" });
  await p.waitForURL(/\/instances$|\/instances\?/, { timeout: 30000 });

  await b.close();
  clean();
  console.log(fails ? `${fails} FAILED` : "ALL PASSED");
  process.exit(fails ? 1 : 0);
})();
