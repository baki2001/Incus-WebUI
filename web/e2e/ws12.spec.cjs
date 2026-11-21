// WS12 checks: waitOp progress on a timed-out /wait, terminal reset between instances,
// file download errors as toasts, command menu for Frozen instances.
// Run: BASE=https://127.0.0.1:8512 STATE=/tmp/claude-0/ws12/state.json node web/e2e/ws12.spec.cjs
// (needs playwright, real Incus, admin/review-pass-2026). Creates w12- objects and removes them at the end.
const { chromium } = require("playwright");
const { execSync } = require("child_process");
const BASE = process.env.BASE || "https://127.0.0.1:8512";
const OUT = process.env.OUT || "/tmp/claude-0/ws12";
const STATE = process.env.STATE || OUT + "/state.json";
const sh = (c) => { try { return execSync(c, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); } catch (e) { return "ERR " + (e.stderr || e.message); } };
let fails = 0;
const check = (name, ok, extra = "") => { console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : "  " + extra)); if (!ok) fails++; };

(async () => {
  for (const n of ["w12-a", "w12-b", "w12-c"]) sh(`incus delete -f ${n}`);
  sh("incus init ubuntu/24.04 w12-a");
  sh("dd if=/dev/urandom of=/var/lib/incus/storage-pools/default/containers/w12-a/rootfs/big.bin bs=1M count=600");
  sh("incus init busybox w12-b; incus start w12-b; incus pause w12-b");

  const b = await chromium.launch();
  const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 }, storageState: STATE });
  const p = await ctx.newPage();
  const dlBtn = (n) => p.getByText(n, { exact: true }).locator("xpath=ancestor::*[.//button[@aria-label='Download']][1]").locator("button[aria-label=Download]").first();

  // 1. copy shows progress even though /wait times out after 1s (Incus 6.0 answers 200 + error body).
  // Real Incus has no progress metadata for a local copy, so the operation read is given some.
  let polls = 0;
  await p.route(/\/operations\/[0-9a-f-]+(\?.*)?$/, async (route) => {
    const r = await route.fetch();
    const j = await r.json().catch(() => null);
    if (j && j.metadata && j.metadata.status_code < 200) { polls++; j.metadata.metadata = { progress: { stage: "copy", percent: String(10 * polls) } }; }
    await route.fulfill({ response: r, json: j });
  });
  await p.goto(BASE + "/instances/vm/w12-a?project=default");
  await p.getByRole("button", { name: "More actions" }).or(p.locator("button:has-text('...')")).first().click().catch(() => {});
  await p.getByRole("button", { name: "Copy", exact: true }).click();
  await p.locator("[role=dialog] input, .dlg input").first().fill("w12-c");
  await p.getByRole("button", { name: /^Copy$/ }).last().click();
  const seen = new Set();
  for (let i = 0; i < 80; i++) {
    const btn = p.locator(".opsbtn");
    if (await btn.count()) {
      if (!(await p.locator(".tray").count())) await btn.click().catch(() => {});
      for (const t of await p.locator(".tray .op small").allTextContents()) seen.add(t);
    }
    if (!(await btn.count()) && sh("incus list w12-c -c s --format csv").startsWith("w12-c")) break;
    await p.waitForTimeout(150);
  }
  console.log("  task details seen:", [...seen].join(" | "), " op reads:", polls);
  check("copy: progress text from the operation read reaches the task tray", [...seen].some((t) => /^copy \d+%/.test(t)), [...seen].join("|"));
  check("copy: instance exists", sh("incus list w12-c -c n --format csv") === "w12-c");
  await p.unroute(/\/operations\/[0-9a-f-]+(\?.*)?$/);

  // 2. terminal does not carry over to another instance
  // (client-side navigation, no reload)
  const sockets = [];
  p.on("websocket", (w) => sockets.push(w.url()));
  await p.goto(BASE + "/instances/vm/app1/terminal?project=default");
  await p.waitForSelector(".xterm", { timeout: 10000 });
  await p.waitForTimeout(1500);
  const aSock = sockets.length;
  await p.locator("a[href='/instances']").first().click();
  await p.getByText("web1", { exact: true }).first().click();
  await p.waitForTimeout(2000);
  check("terminal: opening instance B starts no shell", !(await p.locator(".xterm").count()) && sockets.length === aSock && /web1/.test(p.url()) && !/terminal/.test(p.url()), p.url() + " sockets " + sockets.length + "/" + aSock);

  // 3. download error stays in the app and toasts
  sh("incus start w12-a; sleep 3; incus file push /dev/null w12-a/root/ok.txt");
  await p.goto(BASE + "/instances/vm/w12-a/files?project=default&path=/root");
  await p.getByText("ok.txt").first().waitFor();
  sh("incus file delete w12-a/root/ok.txt");
  const before = p.url();
  await dlBtn("ok.txt").click();
  await p.waitForTimeout(1500);
  check("download error: app stays and a toast shows", p.url() === before && (await p.getByText("Can't download ok.txt.").count()) > 0, p.url());
  await p.screenshot({ path: OUT + "/dl-error.png" });
  // a good download still works and carries the file name
  sh("incus file push /dev/null w12-a/root/good.txt");
  await p.reload();
  await p.getByText("good.txt").first().waitFor();
  const dl = p.waitForEvent("download", { timeout: 8000 }).catch(() => null);
  await dlBtn("good.txt").click();
  const d = await dl;
  check("download ok: file downloads as good.txt", d && d.suggestedFilename() === "good.txt");

  // 5. command menu on a Frozen instance
  await p.goto(BASE + "/instances");
  await p.getByText("Search or run a command").click();
  await p.keyboard.type("w12-b");
  await p.waitForTimeout(1200);
  const txt = await p.locator("body").innerText();
  check("cmdk: Frozen offers Resume + Force stop, not Start", /Resume w12-b/.test(txt) && /Force stop w12-b/.test(txt) && !/Start w12-b/.test(txt), txt.slice(0, 300));
  await p.screenshot({ path: OUT + "/cmdk.png" });
  await p.getByText("Resume w12-b").click();
  await p.waitForTimeout(2500);
  check("cmdk: Resume works on the server", /RUNNING/.test(sh("incus list w12-b -c s --format csv")), sh("incus list w12-b -c s --format csv"));

  await b.close();
  for (const n of ["w12-a", "w12-b", "w12-c"]) sh(`incus delete -f ${n}`);
  console.log(fails ? `${fails} FAILED` : "ALL PASS");
  process.exit(fails ? 1 : 0);
})();
