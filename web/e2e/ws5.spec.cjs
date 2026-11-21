// WS5 checks: networks (dropped connection, ACL picker, forwards), used-by links,
// ACL <-> network attach, profiles in projects that share default's profiles.
// Run: BASE=https://127.0.0.1:8505 node web/e2e/ws5.spec.cjs   (needs playwright, real Incus, admin/review-pass-2026)
// Creates w5- objects and removes them at the end. Bridges use 10.250.x.0/24.
const { chromium } = require("playwright");
const { execSync } = require("child_process");
const BASE = process.env.BASE || "https://127.0.0.1:8505";
const OUT = process.env.OUT || "/tmp/claude-0/ws5";
const sh = (c) => { try { return execSync(c, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); } catch (e) { return "ERR " + (e.stderr || e.message); } };
let fails = 0;
const check = (name, ok, extra = "") => { console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : "  " + extra)); if (!ok) fails++; };

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  const shot = (n) => p.screenshot({ path: `${OUT}/${n}.png` });
  await p.goto(BASE + "/");
  await p.locator("input").first().fill("admin");
  await p.locator("input[type=password]").fill("review-pass-2026");
  await p.keyboard.press("Enter");
  await p.waitForSelector("nav, .side", { timeout: 15000 });

  // cleanup from earlier runs
  sh("incus network forward delete w5-br 10.250.1.1 2>&1");
  sh("incus network delete w5-br 2>&1; incus network acl delete w5-acl1 2>&1; incus network acl delete w5-acl2 2>&1");
  sh("incus network acl create w5-acl1; incus network acl create w5-acl2");

  // ---- 1. create a bridge while the connection drops during the operation
  await p.goto(BASE + "/networks");
  await p.getByRole("button", { name: "Create network" }).click();
  await p.getByPlaceholder("lan0").fill("w5-br");
  await p.getByPlaceholder("10.10.10.1/24").count();
  await p.getByRole("button", { name: "Fixed" }).first().click();
  await p.getByPlaceholder("10.10.10.1/24").fill("10.250.1.1/24");
  let aborted = 0, failed = 0; p.on("requestfailed", () => failed++);
  await p.route(/\/api\/s\/[^/]+\/1\.0\/operations\//, (r) => (aborted++ < 2 ? r.abort() : r.continue()));
  await p.getByRole("button", { name: "Create", exact: true }).click();
  await p.getByText("Network w5-br created").waitFor({ timeout: 30000 });
  check("create survives dropped connection (failed requests: " + failed + ")", sh("incus network show w5-br").includes("status: Created"), `aborted=${aborted}`);
  await p.unroute(/\/api\/s\/[^/]+\/1\.0\/operations\//);
  await p.waitForTimeout(500);
  await shot("net-list");

  // ---- 2. edit with dropped PUT response: abort the PUT itself after it is sent
  await p.getByText("w5-br").first().click();
  await p.getByPlaceholder("1500").fill("1400");
  await p.getByRole("button", { name: "Review and save" }).click();
  let cut = 0;
  await p.route(/\/api\/s\/[^/]+\/1\.0\/networks\/w5-br(\?|$)/, async (r) => {
    if (r.request().method() === "PUT" && !cut++) { await r.fetch(); return r.abort(); }
    return r.continue();
  });
  await p.getByRole("button", { name: "Apply" }).click();
  await p.getByText("Network w5-br saved").waitFor({ timeout: 30000 });
  check("edit survives dropped response", sh("incus network get w5-br bridge.mtu") === "1400", sh("incus network get w5-br bridge.mtu"));
  await p.unroute(/\/api\/s\/[^/]+\/1\.0\/networks\/w5-br(\?|$)/);

  // ---- 3. ACL picker on the network
  await p.getByText("w5-br").first().click();
  await p.getByLabel("w5-acl1").check();
  await shot("net-sheet-acl");
  await p.getByRole("button", { name: "Review and save" }).click();
  await p.getByRole("button", { name: "Apply" }).click();
  await p.getByText("Network w5-br saved").waitFor();
  check("network ACL picker sets security.acls", sh("incus network get w5-br security.acls") === "w5-acl1");

  // ---- 4. port forward
  await p.getByText("w5-br").first().click();
  await p.getByText("Port forwards").waitFor();
  await p.getByRole("button", { name: "Add", exact: true }).first().click();
  await p.getByPlaceholder("192.168.1.20").fill("10.250.1.1");
  await p.getByLabel("Listen port").first().fill("8080");
  await p.getByLabel("Target port").first().fill("80");
  await p.getByLabel("Target address").first().fill("10.250.1.50");
  await shot("forward-dialog");
  await p.getByRole("button", { name: "Add", exact: true }).last().click();
  await p.getByText("Port forward saved").waitFor();
  const fl = sh("incus network forward list w5-br -f csv");
  check("port forward created", fl.includes("10.250.1.1"), fl);
  await p.waitForTimeout(500);
  await shot("net-sheet-forwards");
  await p.getByText("tcp 8080").click();
  await p.getByLabel("Listen port").first().fill("8081");
  await p.getByRole("button", { name: "Save", exact: true }).last().click();
  await p.getByText("Port forward saved").last().waitFor();
  check("port forward edited", sh("incus network forward show w5-br 10.250.1.1").includes("8081"));
  await p.getByText("tcp 8081").click();
  await p.locator(".dlg.md.on .dlg-f button", { hasText: "Delete" }).click();
  await p.locator(".dlg.sm.on .dlg-f button", { hasText: "Delete" }).click();
  await p.getByText("Port forward deleted").waitFor();
  check("port forward deleted", !sh("incus network forward list w5-br -f csv").includes("10.250.1.1"));
  await p.keyboard.press("Escape");

  // ---- 5. used by links + ACL panel networks
  await p.goto(BASE + "/networks/acls");
  await p.getByText("w5-acl1").first().click();
  await p.waitForSelector(".ubl a");
  check("ACL panel lists used-by links", (await p.locator(".ubl a").count()) >= 1);
  await shot("acl-sheet");
  await p.keyboard.press("Escape");
  await p.getByText("w5-acl2").first().click();
  await p.getByLabel("w5-br").check();
  await p.getByRole("button", { name: "Review and save" }).click();
  await p.getByRole("button", { name: "Apply" }).click();
  await p.getByText("ACL w5-acl2 saved").waitFor();
  check("ACL panel attaches network", sh("incus network get w5-br security.acls").split(",").sort().join() === "w5-acl1,w5-acl2", sh("incus network get w5-br security.acls"));
  // link from ACL to network opens that network
  await p.getByText("w5-acl2").first().click();
  await p.locator(".ubl a", { hasText: "w5-br" }).click();
  await p.getByText("Network w5-br").first().waitFor();
  check("used-by link opens the network", p.url().includes("/networks"));
  await p.keyboard.press("Escape");
  // delete dialog shows links
  await p.goto(BASE + "/networks/acls");
  await p.getByText("w5-acl1").first().click();
  await p.getByRole("button", { name: "Delete" }).click();
  await p.waitForSelector(".dlg .ubl a");
  await shot("acl-delete-dialog");
  check("delete dialog lists used-by links", (await p.locator(".dlg .ubl a").count()) >= 1);
  await p.keyboard.press("Escape");

  // ---- 6. profiles in a project that shares default's profiles
  sh("incus project create w5-proj -c features.profiles=false -c features.images=false");
  await p.goto(BASE + "/profiles");
  await p.evaluate(() => localStorage.setItem("iwui.project", "w5-proj"));
  await p.reload();
  await p.getByText("shares profiles with default").count();
  await p.getByText("these are the profiles from project default").waitFor();
  check("shared-profile note shown", true);
  await p.getByRole("button", { name: "Create profile in default" }).click();
  await p.getByText("is created in project default").waitFor();
  await shot("profile-shared-create");
  check("create sheet says it is default", true);
  await p.keyboard.press("Escape");
  await p.evaluate(() => localStorage.setItem("iwui.project", "default"));

  // ---- 7. profile nic network dropdown lists managed networks only
  await p.goto(BASE + "/profiles");
  await p.getByText("Default Incus profile").first().click();
  const opts = await p.locator(".kvr select option").allTextContents();
  check("nic dropdown has no unmanaged networks", !opts.includes("eth0") && opts.includes("incusbr0"), opts.join());
  await p.keyboard.press("Escape");

  // phone width
  await p.setViewportSize({ width: 390, height: 800 });
  await p.goto(BASE + "/networks");
  await p.getByText("w5-br").first().click();
  await p.waitForTimeout(600);
  await shot("net-sheet-phone");
  check("no horizontal scroll on phone", await p.evaluate(() => document.documentElement.scrollWidth <= 391));

  // cleanup
  sh("incus network delete w5-br; incus network acl delete w5-acl1; incus network acl delete w5-acl2; incus project delete w5-proj");
  await b.close();
  console.log(fails ? `${fails} FAILED` : "ALL PASSED");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
