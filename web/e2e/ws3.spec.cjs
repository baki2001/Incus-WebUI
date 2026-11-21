// WS3 checks: instance configuration form and create sheet, against a real Incus.
// Usage: BASE=https://127.0.0.1:8503 node web/e2e/ws3.spec.js
// Assumes the admin/review-pass-2026 account, and the fixtures created by
// the setup block below (objects prefixed w3-, removed at the end).
const { chromium } = require("playwright");
const { execSync } = require("child_process");
const fs = require("fs");

const BASE = process.env.BASE || "https://127.0.0.1:8503";
const OUT = process.env.OUT || "/tmp/claude-0/ws3";
const STATE = OUT + "/state.json";
const sh = (c) => execSync(c, { encoding: "utf8" }).trim();
let fails = 0;
const ok = (c, m) => {
  console.log((c ? "PASS " : "FAIL ") + m);
  if (!c) fails++;
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 }, storageState: fs.existsSync(STATE) ? STATE : undefined });
  const page = await ctx.newPage();
  await page.goto(BASE + "/");
  if (await page.locator("input[type=password]").count()) {
    await page.locator("input:not([type=password])").first().fill("admin");
    await page.fill("input[type=password]", "review-pass-2026");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1500);
    await ctx.storageState({ path: STATE });
  }
  const cfg = async (name, project = "default") => {
    await page.goto(`${BASE}/instances/vm/${name}/configuration?project=${project}`);
    await page.waitForSelector(".hw .hsec");
    await page.waitForTimeout(600);
  };
  const review = async () => {
    await page.getByRole("button", { name: "Review and apply" }).click();
  };
  const apply = async () => {
    await page.locator(".dlg").getByRole("button", { name: /^(Apply|Try again)$/ }).click();
  };

  // ---- setup ----
  try {
    sh("incus info >/dev/null");
    if (!sh("incus profile list -f csv").includes("w3-prof")) {
      sh("incus profile create w3-prof");
      sh("incus profile set w3-prof snapshots.schedule=@daily");
      sh("incus profile set w3-prof limits.memory=768MiB");
      sh("incus profile device add w3-prof pdisk disk source=/tmp path=/mnt/pdisk");
    }
    if (!sh("incus list -f csv -c n").split("\n").includes("w3-a")) sh("incus launch busybox w3-a -p default -p w3-prof");
    for (const c of ["incus config unset w3-a limits.memory", "incus config unset w3-a limits.cpu", "incus config device remove w3-a disk1", "incus config device remove w3-a proxy1", "incus profile assign w3-a default,w3-prof", "incus config unset w3-a user.w3race", "incus config unset w3-a description"]) {
      try {
        sh(c + " 2>/dev/null");
      } catch {}
    }
    if (!sh("incus storage volume list default -f csv").includes("w3-vol")) sh("incus storage volume create default w3-vol");
  } catch (e) {
    console.log("setup failed", e.message);
  }

  // ---- 3: values from profiles ----
  await cfg("w3-a");
  const memInput = page.getByLabel("Memory", { exact: true });
  ok((await memInput.inputValue()) === "768", "profile memory 768 shown as 768 (not 0.8)");
  ok((await page.getByLabel("Memory unit").inputValue()) === "MiB", "unit is MiB");
  ok((await page.getByLabel("Snapshot schedule").inputValue()) === "@daily", "snapshot schedule from profile shown as Daily");
  ok(await page.locator(".hsec .from", { hasText: "From profile w3-prof" }).count() > 0, "from profile label");
  ok((await page.locator('input[aria-label="Host path of pdisk"]').inputValue()) === "/tmp", "profile disk in Extra disks");
  await page.screenshot({ path: OUT + "/cfg-profile.png", fullPage: true });

  // ---- 1: memory in MiB ----
  await memInput.fill("512");
  await review();
  await apply();
  await page.waitForSelector(".dlg", { state: "detached" });
  ok(sh("incus config get w3-a limits.memory") === "512MiB", "memory 512 MiB applied as 512MiB");
  await page.waitForTimeout(800);
  await page.getByLabel("Memory unit").selectOption("GiB");
  await memInput.fill("0.75");
  await review();
  ok((await page.locator(".diff").innerText()).includes("768MiB"), "0.75 GiB normalised to 768MiB in the diff");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Discard" }).click();

  // ---- 5: no volatile keys in diff after failed apply ----
  await cfg("w3-a");
  await page.getByRole("button", { name: "Add disk" }).click();
  await page.getByLabel("Host path of disk1").fill("/nonexistent-w3");
  await page.getByLabel("Path inside for disk1").fill("/mnt/x");
  await review();
  await apply();
  await page.waitForSelector(".dlg .cerr");
  ok(true, "failed apply shows error inside the dialog: " + (await page.locator(".dlg .cerr").innerText()));
  await page.screenshot({ path: OUT + "/cfg-fail.png" });
  await page.getByRole("button", { name: "Keep editing" }).click();
  ok((await page.locator(".hwbar b").innerText()).startsWith("1 change"), "draft still has 1 change (no volatile keys)");

  // ---- 4: volume picker ----
  await page.getByLabel("Source of disk1").selectOption("vol");
  await page.getByLabel("Pool of disk1").selectOption("default");
  await page.getByLabel("Volume of disk1").selectOption("w3-vol");
  await page.screenshot({ path: OUT + "/cfg-disks.png", fullPage: true });
  await review();
  await apply();
  await page.waitForSelector(".dlg", { state: "detached" });
  ok(/source: w3-vol/.test(sh("incus config device show w3-a")) , "volume disk attached");
  await page.waitForTimeout(800);

  // ---- 2: ETag conflict ----
  await cfg("w3-a");
  await page.getByLabel("Description").fill("edited in UI");
  sh("incus config set w3-a user.w3race=1");
  await page.waitForTimeout(300);
  await review();
  await apply();
  await page.waitForSelector(".cfl");
  ok(await page.locator(".cfl").isVisible(), "412 conflict banner shown");
  ok(sh("incus config get w3-a user.w3race") === "1" && sh("incus config show w3-a").includes("description: edited in UI") === false, "other change not overwritten");
  await page.screenshot({ path: OUT + "/cfg-conflict.png" });
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await page.waitForTimeout(800);
  sh("incus config unset w3-a user.w3race");

  // ---- 6: validation ----
  await cfg("w3-a");
  const cpuIn = page.getByLabel("CPU cores");
  await cpuIn.fill("-2");
  ok(await page.locator(".note.bad", { hasText: "negative" }).isVisible(), "negative CPU marked on field");
  await cpuIn.fill("999");
  ok(await page.locator(".note.warn").first().isVisible(), "CPU above host threads warns");
  await review();
  await page.waitForSelector(".dlg .wlist").catch(() => {});
  ok(await page.locator(".dlg .wlist").isVisible(), "warning repeated in review, apply allowed");
  await page.keyboard.press("Escape");
  await cpuIn.fill("2");
  ok(await page.getByRole("button", { name: "Remove limit" }).isVisible(), "Remove limit button visible");
  await page.getByLabel("Memory unit").selectOption("GiB");
  await memInput.fill("-1");
  ok(await page.locator(".note.bad", { hasText: "negative" }).isVisible(), "negative memory marked");
  await review();
  ok(!(await page.locator(".dlg.on").count()), "review blocked while invalid");
  await page.screenshot({ path: OUT + "/cfg-invalid.png", fullPage: true });
  await page.getByRole("button", { name: "Discard" }).click();

  // ---- 7/8: network, profiles, proxy ----
  await cfg("w3-a");
  const opts = await page.getByLabel("Network of eth0").locator("option").allInnerTexts();
  ok(!opts.includes("eth0") && opts.includes("incusbr0") && opts.some((o) => o.startsWith("Host interface")), "network picker: managed only + host interface option: " + opts.join(", "));
  await page.getByLabel("Add profile").selectOption("small");
  await page.getByRole("button", { name: "Add port forward" }).click();
  await page.getByLabel("Host port of proxy1").fill("18083");
  await page.getByLabel("Instance port of proxy1").fill("80");
  await page.getByLabel("Reachable from, proxy1").selectOption("host");
  await review();
  await apply();
  await page.waitForSelector(".dlg", { state: "detached" });
  ok(sh("incus profile list -f csv").length > 0 && sh("incus config show w3-a").includes("- small"), "profile added");
  ok(/listen: tcp:127.0.0.1:18083/.test(sh("incus config device show w3-a")), "proxy device listens on host only");
  await page.waitForTimeout(800);
  await page.screenshot({ path: OUT + "/cfg-after.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: OUT + "/cfg-phone.png", fullPage: true });
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= 391), "config: no horizontal scroll at 390px");
  await page.setViewportSize({ width: 1280, height: 900 });

  // ---- 9: create ----
  await page.goto(BASE + "/instances");
  await page.getByRole("button", { name: /Create/ }).first().click();
  await page.waitForSelector(".sheet.on");
  await page.waitForTimeout(1500);
  ok(await page.getByRole("button", { name: "OCI registry" }).count() === 0, "OCI tab hidden without instance_oci");
  ok((await page.locator(".sheet [aria-label=\"Image source\"] button[aria-pressed=true]").first().innerText()).startsWith("On this server"), "opened on On this server when image server unreachable");
  await page.screenshot({ path: OUT + "/create.png" });
  await page.locator(".sheet input[placeholder='web-01']").fill("w3-a");
  await page.waitForTimeout(600);
  ok(await page.locator(".sheet .hint.bad", { hasText: "already exists" }).isVisible(), "duplicate name flagged before submit");
  await page.locator(".sheet input[placeholder='web-01']").fill("w3-new");
  // dirty guard
  await page.keyboard.press("Escape");
  await page.waitForSelector(".dlg.on");
  ok(await page.locator(".dlg.on", { hasText: "Discard your changes?" }).isVisible(), "dirty guard asks before discarding");
  await page.getByRole("button", { name: "Cancel" }).last().click();
  await page.waitForTimeout(400);
  ok(await page.locator(".sheet.on").isVisible(), "sheet stays open after cancel");

  // pick local image, memory 512MiB, extra disk + proxy, failure stays inside
  await page.locator(".iopt").first().click();
  await page.getByLabel("Memory unit").first().selectOption("MiB");
  await page.getByLabel("Memory", { exact: true }).first().fill("512");
  await page.getByRole("button", { name: "Add port forward" }).click();
  await page.getByLabel("Host port of proxy1").fill("18084");
  await page.getByLabel("Instance port of proxy1").fill("80");
  await page.getByRole("button", { name: "Add disk" }).click();
  await page.getByLabel("Source of disk1").selectOption("vol");
  await page.getByLabel("Volume of disk1").selectOption("w3-vol");
  await page.getByLabel("Path inside for disk1").fill("/mnt/v");
  await page.getByRole("button", { name: "Add disk" }).click();
  await page.getByLabel("Host path of disk2").fill("/nonexistent-w3");
  await page.getByLabel("Path inside for disk2").fill("/mnt/bad");
  await page.getByRole("button", { name: /^Show$/ }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: OUT + "/create-filled.png" });
  await page.getByRole("button", { name: /^Create and/ }).click();
  await page.waitForSelector(".sheet .cerr", { timeout: 20000 });
  ok(await page.locator(".sheet.on").isVisible(), "creation failure keeps the form open: " + (await page.locator(".sheet .cerr").innerText()));
  await page.screenshot({ path: OUT + "/create-error.png" });
  await page.getByRole("button", { name: "Remove disk2" }).click();
  await page.getByRole("button", { name: /^Create and/ }).click();
  await page.waitForURL(/instances\/vm\/w3-new/, { timeout: 60000 });
  await page.waitForTimeout(800);
  ok(sh("incus config get w3-new limits.memory") === "512MiB", "created with memory 512MiB");
  ok(/source: w3-vol/.test(sh("incus config device show w3-new")) && /listen: tcp:0.0.0.0:18084/.test(sh("incus config device show w3-new")), "created with volume disk and proxy");

  // phone create
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(BASE + "/instances");
  await page.getByRole("button", { name: /Create/ }).first().click();
  await page.waitForSelector(".sheet.on");
  await page.waitForTimeout(800);
  await page.screenshot({ path: OUT + "/create-phone.png" });
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= 391), "create: no horizontal scroll at 390px");

  // ---- cleanup ----
  await browser.close();
  if (!process.env.KEEP) {
    for (const c of ["incus delete -f w3-new", "incus delete -f w3-a", "incus profile delete w3-prof", "incus storage volume delete default w3-vol"]) {
      try {
        sh(c);
      } catch {}
    }
  }
  console.log(fails ? `${fails} FAILED` : "ALL PASSED");
  process.exit(fails ? 1 : 0);
})();
