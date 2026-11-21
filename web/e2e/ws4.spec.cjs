// WS4 check: volume snapshots, detach, used-by links, image toggles, import.
// Usage: BASE=https://127.0.0.1:8504 node web/e2e/ws4.spec.js
// Needs: playwright, the `incus` CLI, and the images busybox + an instance w4-ct (created here).
const { chromium } = require("playwright");
const { execSync } = require("child_process");
const fs = require("fs");
const BASE = process.env.BASE || "https://127.0.0.1:8504";
const OUT = process.env.OUT || "/tmp/claude-0/ws4";
const sh = (c) => execSync(c, { encoding: "utf8" }).trim();
const ok = (c, m) => {
  console.log((c ? "PASS " : "FAIL ") + m);
  if (!c) process.exitCode = 1;
};

(async () => {
  const browser = await chromium.launch();
  const state = OUT + "/state.json";
  let ctx = await browser.newContext({ ignoreHTTPSErrors: true, ...(fs.existsSync(state) ? { storageState: state } : {}), viewport: { width: 1280, height: 900 } });
  let page = await ctx.newPage();
  await page.goto(BASE + "/storage/volumes");
  if (await page.locator("#u").count()) {
    await page.fill("#u", "admin");
    await page.fill("#p", "review-pass-2026");
    await page.keyboard.press("Enter");
    await page.waitForSelector("nav");
    await ctx.storageState({ path: state });
  }
  const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png` });

  // ---- fixtures
  const tryRun = (c) => { try { sh(c + " 2>&1"); } catch {} };
  tryRun("incus storage volume create default w4-vol size=1GiB");
  tryRun("incus storage volume create default w4-blk --type=block size=100MiB");
  tryRun("incus launch busybox w4-ct");
  tryRun("incus query -X DELETE /1.0/images/aliases/w4-alias");
  tryRun("incus storage volume unset default w4-vol snapshots.schedule");
  tryRun("incus config device remove w4-ct w4-vol");

  // ---- volume snapshots
  await page.goto(BASE + "/storage/volumes");
  await page.waitForSelector("text=w4-vol");
  ok((await page.locator("td", { hasText: "w4-vol/" }).count()) === 0, "snapshot rows are not listed as volumes");
  await page.locator("tr", { hasText: "w4-vol" }).first().click();
  await page.waitForSelector("text=Take snapshot");
  await page.fill('input[placeholder="Optional"]', "e2e-a");
  await page.fill('input[aria-label="Expires"]', "2030-01-02T03:04");
  await page.click("text=Take snapshot");
  await page.waitForSelector(".snr:has-text('e2e-a')");
  ok(/e2e-a/.test(sh("incus storage volume info default w4-vol")), "snapshot created on server");
  ok(/2030/.test(sh("incus query /1.0/storage-pools/default/volumes/custom/w4-vol/snapshots/e2e-a")), "expiry set");
  await shot("vol-sheet");
  // restore: write a file, restore, file gone
  sh("echo hi > /var/lib/incus/storage-pools/default/custom/default_w4-vol/marker");
  await page.locator(".snr", { hasText: "e2e-a" }).getByText("Restore").click();
  await page.locator(".dlg button.btn-d").click();
  await page.waitForSelector("text=restored from e2e-a");
  ok(!fs.existsSync("/var/lib/incus/storage-pools/default/custom/default_w4-vol/marker"), "restore reverted the volume");
  // delete
  await page.locator(".snr", { hasText: "e2e-a" }).getByLabel("Delete e2e-a").click();
  await page.locator(".dlg button.btn-d").click();
  await page.waitForSelector(".snr:has-text('e2e-a')", { state: "detached" });
  ok(!/e2e-a/.test(sh("incus storage volume info default w4-vol")), "snapshot deleted on server");
  // schedule + volatile hidden
  ok((await page.locator('.kved input[value^="volatile."]').count()) === 0, "volatile keys hidden in All settings");
  await page.fill('input[placeholder="@daily"]', "@daily");
  await page.click("text=Review and save");
  await page.locator(".dlg button.btn-p").click();
  await page.waitForSelector("text=saved");
  ok(/@daily/.test(sh("incus storage volume get default w4-vol snapshots.schedule")), "schedule saved");

  // ---- attach + detach
  await page.goto(BASE + "/storage/volumes");
  await page.locator("tr", { hasText: "w4-vol" }).first().click();
  await page.selectOption(".sheet select", "w4-ct");
  await page.getByRole("button", { name: "Attach", exact: true }).click();
  await page.waitForSelector(".ul-r:has-text('w4-ct')");
  ok(/w4-vol/.test(sh("incus config device list w4-ct")), "attached on server");
  ok((await page.locator(".ul-r a", { hasText: "w4-ct" }).count()) === 1, "used by shows a link to the instance");
  await shot("vol-used");
  // delete dialog lists what blocks
  await page.locator(".sheet-f button", { hasText: "Delete" }).click();
  await page.waitForSelector(".dlg.on");
  ok((await page.locator(".dlg .ul-r a", { hasText: "w4-ct" }).count()) === 1, "delete dialog lists users as links");
  await shot("vol-delete-dlg");
  await page.locator(".dlg button", { hasText: "Cancel" }).click();
  await page.locator(".ul-r", { hasText: "w4-ct" }).getByText("Detach").click();
  await page.locator(".dlg button.btn-p").click();
  await page.waitForSelector(".ul-r:has-text('w4-ct')", { state: "detached" });
  ok(!/w4-vol/.test(sh("incus config device list w4-ct")), "detached on server");

  // block volume: only VMs are offered
  await page.keyboard.press("Escape");
  await page.locator("tr", { hasText: "w4-blk" }).first().click();
  await page.waitForSelector("text=Attach to an instance");
  const opts = await page.locator(".sheet select option").allTextContents();
  ok(!opts.includes("w4-ct"), "block volume does not offer containers");
  await page.keyboard.press("Escape");

  // ---- pool delete dialog
  await page.goto(BASE + "/storage");
  await page.locator("tr", { hasText: "default" }).first().click();
  await page.locator(".sheet-f button", { hasText: "Delete" }).click();
  await page.waitForSelector(".dlg.on");
  ok((await page.locator(".dlg .ul-r").count()) > 0, "pool delete dialog lists users");
  await page.locator(".dlg button", { hasText: "Cancel" }).click();

  // ---- images: toggles refresh
  await page.goto(BASE + "/images");
  await page.waitForSelector("text=busybox");
  await page.locator("tr", { hasText: "busybox" }).first().click();
  ok((await page.getByRole("switch", { name: "Keep it up to date" }).count()) === 0, "no auto-update switch for an image without a source");
  const pub = page.getByRole("switch", { name: "Public" });
  await pub.click();
  await page.waitForFunction(() => document.querySelector('[role=switch][aria-label=Public]')?.getAttribute("aria-checked") === "true");
  ok(/yes/.test(sh("incus image list busybox -f csv -c p")), "image public on server and UI switch followed");
  await pub.click();
  await page.waitForFunction(() => document.querySelector('[role=switch][aria-label=Public]')?.getAttribute("aria-checked") === "false");
  ok(/no/.test(sh("incus image list busybox -f csv -c p")), "image private again, UI followed");
  // alias panel stays open, error keeps text
  await page.fill('input[placeholder="Add a name"]', "w4-alias");
  await page.click("button:text-is('Add')");
  await page.waitForSelector(".drow:has-text('w4-alias')");
  ok(await page.locator(".sheet.on").count() === 1, "sheet stays open after adding a name");
  await page.fill('input[placeholder="Add a name"]', "w4-alias");
  await page.click("button:text-is('Add')");
  await page.waitForTimeout(800);
  ok((await page.locator(".sheet.on").count()) === 1 && (await page.inputValue('input[placeholder="Add a name"]')) === "w4-alias", "sheet stays open and keeps the text on error");
  await page.getByLabel("Remove w4-alias").click();
  await page.waitForSelector(".drow:has-text('w4-alias')", { state: "detached" });
  await page.keyboard.press("Escape");

  // ---- images: import
  const d = fs.mkdtempSync(OUT + "/imp-");
  sh(`cd ${d} && incus image export busybox x && mkdir m u && tar -xf x -C m`);
  const meta = (desc) => fs.readFileSync(d + "/m/metadata.yaml", "utf8").replace("Busybox 1.36 (test)", desc);
  fs.writeFileSync(d + "/u/metadata.yaml", meta("w4 unified"));
  fs.mkdirSync(d + "/u/rootfs");
  sh(`cd ${d}/u && tar -czf ../unified.tar.gz metadata.yaml rootfs`);
  fs.writeFileSync(d + "/m/metadata.yaml", meta("w4 split"));
  sh(`cd ${d}/m && tar -czf ../split-meta.tar.gz metadata.yaml`);
  const importOne = async (files, alias, desc) => {
    await page.click("text=Import from file");
    await page.setInputFiles(".sheet input[type=file] >> nth=0", files[0]);
    if (files[1]) await page.setInputFiles(".sheet input[type=file] >> nth=1", files[1]);
    await page.fill(".sheet input.mono", alias);
    await page.click(".sheet-f button.btn-p");
    await page.waitForSelector("text=Image imported", { timeout: 60000 });
    ok(new RegExp(alias).test(sh("incus image list -f csv -c ld")) && sh("incus image list -f csv -c ld").includes(desc), `imported ${desc} with alias ${alias}`);
  };
  await importOne([`${d}/unified.tar.gz`], "w4-uni", "w4 unified");
  await page.waitForSelector(".sheet", { state: "detached" });
  await importOne([`${d}/split-meta.tar.gz`, `${d}/x.root`], "w4-split", "w4 split");
  await page.waitForSelector(".sheet", { state: "detached" });
  await page.waitForSelector("text=w4 split");
  await shot("images-after-import");
  tryRun("incus image delete w4-uni");
  tryRun("incus image delete w4-split");

  // ---- images: unreachable server message + retry
  await page.click("text=Pull image");
  await page.waitForSelector(".ilist .emp");
  const msg = await page.locator(".ilist .emp").innerText();
  ok(/Can't reach|answered|took too long/.test(msg) && !/dial tcp|lookup/.test(msg), "unreachable server message is readable: " + msg.replace(/\n/g, " "));
  ok((await page.locator(".ilist .emp button", { hasText: "Retry" }).count()) === 1, "Retry button present");
  ok(/OCI registries need|OCI registry/.test(await page.locator(".sheet").innerText()), "OCI explained or offered");
  await shot("pull-sheet");

  // ---- phone
  const m = await browser.newContext({ ignoreHTTPSErrors: true, storageState: state, viewport: { width: 390, height: 800 } });
  const mp = await m.newPage();
  await mp.goto(BASE + "/images");
  await mp.waitForSelector("text=busybox");
  const sw = await mp.evaluate(() => document.documentElement.scrollWidth);
  ok(sw <= 390, "images page has no horizontal scroll on phone (" + sw + ")");
  await mp.screenshot({ path: OUT + "/images-phone.png" });
  await mp.goto(BASE + "/storage/volumes");
  await mp.locator("tr", { hasText: "w4-vol" }).first().click();
  await mp.waitForSelector("text=Take snapshot");
  await mp.waitForTimeout(700);
  await mp.screenshot({ path: OUT + "/vol-phone.png", fullPage: false });
  await mp.evaluate(() => document.querySelector(".sheet-b").scrollTo(0, 99999));
  await mp.screenshot({ path: OUT + "/vol-phone-2.png" });
  const small = await mp.evaluate(() => [...document.querySelectorAll(".sheet .snr .btn, .sheet .ul-r .btn, .sheet .tt")].filter((b) => b.getBoundingClientRect().height < 38 && b.offsetParent).map((b) => b.textContent.trim() || b.ariaLabel));
  ok(small.length === 0, "touch targets in the volume sheet >= 38px on phone " + JSON.stringify(small));
  const dk = await browser.newContext({ ignoreHTTPSErrors: true, storageState: state, viewport: { width: 1000, height: 900 }, colorScheme: "dark" });
  const dp = await dk.newPage();
  await dp.goto(BASE + "/storage/volumes");
  await dp.locator("tr", { hasText: "w4-vol" }).first().click();
  await dp.waitForTimeout(700);
  await dp.screenshot({ path: OUT + "/vol-dark.png" });
  ok((await mp.evaluate(() => document.documentElement.scrollWidth)) <= 390, "volume sheet fits on phone");
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
