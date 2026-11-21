// End-to-end check for WireGuard tunnels (WS9). Plain node script:
//   BASE=https://127.0.0.1:8509 WGGO=/path/to/wireguard-go NODE_PATH=/opt/node22/lib/node_modules node web/e2e/ws9.spec.cjs
// Assumes admin / review-pass-2026, a local `incus` CLI, the local ubuntu/24.04 and busybox images, and a
// server started with INCUS_WEBUI_WG_TEST=1 (this machine has no WireGuard kernel module, so the test
// pushes a wireguard-go binary into the gateways; the product itself doesn't need it).
const { chromium } = require("playwright");
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");

const BASE = process.env.BASE || "https://127.0.0.1:8509";
const WGGO = process.env.WGGO || "/tmp/claude-0/ws9/wggo/wireguard-go";
const OUT = process.env.OUT || "/tmp/claude-0/ws9";
const sh = (...a) => execFileSync("incus", a, { encoding: "utf8" });
const tryIncus = (...a) => spawnSync("incus", a, { encoding: "utf8" });
let fails = 0;
const ok = (c, msg) => {
  console.log((c ? "PASS " : "FAIL ") + msg);
  if (!c) fails++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, ms = 30000, step = 500) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* retry */
    }
    await sleep(step);
  }
  return false;
}

(async () => {
  for (const n of ["w9-gw", "w9-cl", "w9-vps", "w9-vpsgw", "w9-web", "w9-mon", "w9-gw2"]) tryIncus("delete", "-f", n);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 860 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const bodies = [];
  page.on("request", (r) => r.url().includes("/api/ui/") && r.postData() && bodies.push(r.url() + " " + r.postData()));

  const shot = async (name) => {
    for (const [mode, scheme, vp] of [["light", "light", { width: 1280, height: 860 }], ["dark", "dark", { width: 1280, height: 860 }], ["phone", "light", { width: 390, height: 844 }]]) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize(vp);
      await sleep(350);
      if (mode === "phone") {
        const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        ok(over <= 0, `no horizontal scroll at 390px on ${name} (${over})`);
      }
      await page.screenshot({ path: `${OUT}/ws9-${name}-${mode}.png` });
    }
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 1280, height: 860 });
  };

  // log in once
  await page.goto(BASE + "/tunnels");
  await page.fill("#u", "admin");
  await page.fill("#p", "review-pass-2026");
  await page.keyboard.press("Enter");
  await page.waitForSelector("text=Overview");
  await page.goto(BASE + "/tunnels");
  await page.waitForSelector("h1:has-text('Tunnels')");
  await page.waitForSelector(".empty:has-text('No tunnels yet')");
  await shot("empty");

  // ---- wizard 1: remote access
  await page.click("text=Add tunnel");
  await page.click(".menu >> text=Remote access");
  await page.waitForSelector(".sheet.on");
  await page.fill("input[placeholder='vpn.example.com']", "vpn.example.com");
  await page.fill(".fl:has(label:text-is('UDP port')) input", "51899");
  await page.fill(".fl:has(label:text-is('Name')) input", "w9-gw");
  await sleep(500);
  await shot("wizard-remote");
  await page.click("button:has-text('Create gateway')");
  await page.waitForSelector("text=is created.", { timeout: 240000 });
  ok(await page.locator("text=WireGuard isn't available in this kernel").count() > 0, "no kernel module: the UI says so clearly");
  await shot("wizard-remote-result");
  const inst = sh("config", "show", "w9-gw");
  ok(/user.incus-webui.tunnel: remote-access/.test(inst) && /linux.kernel_modules|path: \/dev\/net\/tun/.test(inst), "gateway instance exists with the tunnel marker");
  ok(!/PrivateKey/.test(fs.readFileSync("/tmp/claude-0/ws9-data/config.yaml", "utf8")), "nothing secret in config.yaml");
  await page.click("button:has-text('Done')");

  // give the gateway a userspace WireGuard (test machine only), then use "Try again"
  sh("file", "push", WGGO, "w9-gw/usr/local/bin/wireguard-go", "--mode", "0755");
  await page.waitForSelector("button:has-text('Try again')");
  await page.click("button:has-text('Try again')");
  await page.waitForSelector(".tn .st.running", { timeout: 60000 });
  ok(true, "Try again brings the interface up");

  // ---- add a device: keys are made in the browser
  await page.click("button:has-text('Add device')");
  await page.fill(".dlg input", "laptop");
  await page.click("button:has-text('Create device')");
  await page.waitForSelector("svg.tn-qr");
  await shot("add-device");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("button:has-text('Download .conf')")]);
  const confPath = `${OUT}/ws9-laptop.conf`;
  await dl.saveAs(confPath);
  const conf = fs.readFileSync(confPath, "utf8");
  ok(dl.suggestedFilename() === "laptop.conf", "downloaded laptop.conf");
  const priv = /PrivateKey = (\S+)/.exec(conf)[1];
  const psk = /PresharedKey = (\S+)/.exec(conf)[1];
  ok(priv.length === 44 && !bodies.some((b) => b.includes(priv)), "client private key never sent to the server");
  ok(bodies.some((b) => b.includes(psk)), "preshared key is sent (both ends need it)");
  ok(/AllowedIPs = 10\.66\.0\.0\/24, 10\.\d+\.\d+\.0\/24/.test(conf) && /Endpoint = vpn\.example\.com:51899/.test(conf), "client config has tunnel + chosen subnet, no full LAN");
  await page.click("button:has-text('Done')");
  const gwConf = sh("exec", "w9-gw", "--", "cat", "/etc/wireguard/wg0.conf");
  ok(/# name: laptop/.test(gwConf) && !/PrivateKey/.test(gwConf), "peer name stored as comment, gateway private key not in conf");
  ok(sh("exec", "w9-gw", "--", "wg", "show", "wg0", "peers").trim().length === 44, "peer is live on the interface");

  // ---- real handshake from a client container
  sh("copy", "w9-gw", "w9-cl");
  sh("config", "device", "remove", "w9-cl", "wg-udp");
  sh("config", "unset", "w9-cl", "user.incus-webui.tunnel");
  sh("start", "w9-cl");
  await until(() => tryIncus("exec", "w9-cl", "--", "true").status === 0);
  const gwIP = (await until(() => /inet (10\.\d+\.\d+\.\d+)/.exec(sh("exec", "w9-gw", "--", "ip", "-4", "addr", "show", "eth0"))))[1];
  const cc = conf.replace(/Endpoint = .*/, `Endpoint = ${gwIP}:51899`).replace(/AllowedIPs = .*/, "AllowedIPs = 10.66.0.0/24");
  fs.writeFileSync(`${OUT}/ws9-client.conf`, cc);
  tryIncus("exec", "w9-cl", "--", "systemctl", "disable", "--now", "wg-quick@wg0");
  sh("file", "push", `${OUT}/ws9-client.conf`, "w9-cl/etc/wireguard/wgc.conf", "--mode", "0600");
  const up = tryIncus("exec", "w9-cl", "--", "wg-quick", "up", "wgc");
  ok(up.status === 0, "client brought up its tunnel");
  const ping = await until(() => /^\d{5,}/.test((tryIncus("exec", "w9-cl", "--", "wg", "show", "wgc", "latest-handshakes").stdout.split("\t")[1] || "").trim()), 30000);
  ok(!!ping, "client completed a WireGuard handshake with the gateway");
  await page.waitForSelector(".tn-hs:not(.warn):has-text('ago'), .tn-hs:not(.warn):has-text('just now')", { timeout: 45000 });
  ok(true, "UI shows the last handshake");
  await shot("list-with-peers");

  // a peer that had handshakes and is silent > 3 minutes turns warn-coloured; others don't
  await page.clock.install({ time: Date.now() });
  await page.reload();
  await page.waitForSelector(".tn-hs");
  ok((await page.locator(".tn-hs.warn").count()) === 0, "recent handshake: no warning colour");
  await page.clock.fastForward("04:00");
  await sleep(1500);
  ok((await page.locator(".tn-hs.warn").count()) === 1, "silent for 4 min after handshakes: warning colour");
  await shot("list-stale");
  await page.reload();

  // second device, then revoke it from the UI
  await page.click("button:has-text('Add device')");
  await page.fill(".dlg input", "phone");
  await page.click("button:has-text('Create device')");
  await page.waitForSelector("svg.tn-qr");
  await page.click("button:has-text('Done')");
  await page.waitForSelector(".tn-peer:has-text('phone')");
  ok(!(await page.locator(".tn-peer:has-text('phone') .tn-hs.warn").count()), "never-connected peer has no warning colour");
  const phoneKey = sh("exec", "w9-gw", "--", "wg", "show", "wg0", "peers").trim().split("\n").length;
  ok(phoneKey === 2, "two peers on the interface");
  await page.click(".tn-peer:has-text('phone') button[aria-label^='Remove']");
  await page.click(".dlg button:has-text('Remove device')");
  await page.waitForSelector(".tn-peer:has-text('phone')", { state: "detached", timeout: 15000 });
  ok(sh("exec", "w9-gw", "--", "wg", "show", "wg0", "peers").trim().split("\n").length === 1 && !/phone/.test(sh("exec", "w9-gw", "--", "cat", "/etc/wireguard/wg0.conf")), "revoked peer removed from the interface and the conf");

  // ---- wizard 2: homelab to VPS, with a container playing the VPS
  sh("launch", "ubuntu/24.04", "w9-vps");
  sh("config", "device", "add", "w9-vps", "tun", "unix-char", "path=/dev/net/tun"); // only for wireguard-go in this test
  sh("launch", "busybox", "w9-web");
  const ipOf = async (n) => (await until(() => /inet (10\.\d+\.\d+\.\d+)/.exec(sh("exec", n, "--", "ip", "-4", "addr", "show", "eth0"))))[1];
  // The VPS container must not sit in the home subnet (the VPS routes it into the tunnel), but lan2 has no
  // internet: install the packages first, then move it to lan2.
  await until(() => tryIncus("exec", "w9-vps", "--", "sh", "-c", "apt-get update -qq && apt-get install -y -qq wireguard-tools iptables").status === 0, 180000, 3000);
  sh("file", "push", WGGO, "w9-vps/usr/local/bin/wireguard-go", "--mode", "0755");
  sh("stop", "w9-vps");
  sh("config", "device", "override", "w9-vps", "eth0", "network=lan2");
  sh("start", "w9-vps");
  const vpsIP = (await until(() => /inet (10\.77\.\d+\.\d+)/.exec(tryIncus("exec", "w9-vps", "--", "ip", "-4", "addr", "show", "eth0").stdout), 60000))[1];
  const webIP = await ipOf("w9-web");
  spawnSync("incus", ["exec", "w9-web", "--", "sh", "-c", "mkdir -p /www && echo hello-from-web > /www/index.html && (busybox httpd -p 80 -h /www)"]);
  await page.click("text=Add tunnel");
  await page.click(".menu >> text=Homelab to VPS");
  await page.waitForSelector(".sheet.on");
  await page.fill("input[placeholder='203.0.113.10']", vpsIP);
  await page.fill(".fl:has(label:text-is('UDP port on the VPS')) input", "51821");
  await page.fill(".fl:has(label:text-is('Name')) input", "w9-vpsgw");
  await page.click("button:has-text('Add port')");
  await page.fill("input[aria-label='Public port on the VPS']", "8081");
  await page.fill("input[aria-label='Port on the instance']", "80");
  await page.selectOption("select[aria-label='Instance']", { value: webIP });
  await sleep(400);
  await shot("wizard-vps");
  await page.click("button:has-text('Create gateway')");
  await page.waitForSelector("text=is created", { timeout: 240000 });
  const script = await page.locator(".tn-pre").first().innerText();
  ok(/wg-quick@wg0/.test(script) && /DNAT --to-destination/.test(script) && !script.includes("@VPS_PRIVATE_KEY@"), "VPS install script has the config, DNAT rule and a real private key");
  await shot("wizard-vps-result");
  fs.writeFileSync(`${OUT}/ws9-vps-install.sh`, script + "\n");
  // the gateway is down until wireguard-go exists in it (test machine only)
  sh("file", "push", WGGO, "w9-vpsgw/usr/local/bin/wireguard-go", "--mode", "0755");
  const r = spawnSync("incus", ["exec", "w9-vpsgw", "--", "systemctl", "restart", "wg-quick@wg0"]);
  ok(r.status === 0, "gateway interface starts");
  // the VPS "install": the apt step needs internet, then run the generated script
  // (no internet on lan2: the packages are already installed, so skip the apt lines)
  const run = spawnSync("incus", ["exec", "w9-vps", "--", "sh", "-s"], { input: script.replace(/^apt-get .*$/gm, ""), encoding: "utf8" });
  console.log((run.stdout + run.stderr).split("\n").slice(-6).join("\n"));
  ok(run.status === 0, "generated install script runs on the VPS");
  await page.click("button:has-text('Done')");
  const hs = await until(() => /^\d{5,}/.test(spawnSync("incus", ["exec", "w9-vps", "--", "wg", "show", "wg0", "latest-handshakes"], { encoding: "utf8" }).stdout.split("\t")[1] || ""), 60000, 2000);
  ok(!!hs, "homelab gateway dialled out and completed a handshake with the VPS");
  const body = await until(() => spawnSync("curl", ["-s", "-m", "5", `http://${vpsIP}:8081/`], { encoding: "utf8" }).stdout.includes("hello-from-web"), 30000, 2000);
  ok(!!body, "a published port on the VPS reaches the instance at home through the tunnel");
  await page.waitForSelector(".tn:has-text('w9-vpsgw') .tn-peer:has-text('vps')", { timeout: 30000 });
  await shot("list-two");

  // ---- wizard 3: monitor an instance that already runs WireGuard
  sh("copy", "w9-gw", "w9-mon");
  sh("config", "device", "remove", "w9-mon", "wg-udp");
  sh("config", "unset", "w9-mon", "user.incus-webui.tunnel");
  sh("start", "w9-mon");
  await until(() => tryIncus("exec", "w9-mon", "--", "true").status === 0);
  tryIncus("exec", "w9-mon", "--", "systemctl", "restart", "wg-quick@wg0");
  await page.click("text=Add tunnel");
  await page.click(".menu >> text=Monitor an existing tunnel");
  await page.waitForSelector(".sheet.on .tn-pickrow:has-text('w9-mon')");
  await page.fill(".sheet .fsearch input", "w9-");
  await sleep(300);
  await shot("wizard-monitor");
  // an instance without WireGuard is refused with a clear reason
  await page.click(".tn-pickrow:has-text('w9-web') button");
  await page.waitForSelector(".tn-bad");
  ok(/WireGuard tools aren't installed|No WireGuard interface/.test(await page.locator(".tn-bad").innerText()), "instance without WireGuard: clear reason");
  await page.click(".tn-pickrow:has-text('w9-mon') button");
  await page.waitForSelector(".tn:has-text('w9-mon')", { timeout: 20000 });
  ok(/Monitored/.test(await page.locator(".tn:has-text('w9-mon')").innerText()), "monitored instance listed");
  ok((await page.locator(".tn:has-text('w9-mon') button:has-text('Add device')").count()) === 0 && (await page.locator(".tn:has-text('w9-mon') button[aria-label^='Remove']").count()) === 0, "monitor is read-only: no add or revoke");
  ok(/user.incus-webui.tunnel: monitor/.test(sh("config", "show", "w9-mon")), "only a user.* key is stored on the instance");
  await shot("list-monitor");
  await page.click(".tn:has-text('w9-mon') button:has-text('Stop monitoring')");
  await page.click(".dlg button:has-text('Stop monitoring')");
  await page.waitForSelector(".tn:has-text('w9-mon')", { state: "detached", timeout: 15000 });
  ok(tryIncus("info", "w9-mon").status === 0, "stop monitoring leaves the instance alone");

  // ---- delete gateways from the UI
  for (const n of ["w9-vpsgw", "w9-gw"]) {
    await page.click(`.tn:has-text('${n}') button:has-text('Delete')`);
    await page.click(".dlg button:has-text('Delete gateway')");
    await page.waitForSelector(`.tn:has-text('${n}')`, { state: "detached", timeout: 60000 });
    ok(tryIncus("info", n).status !== 0, `${n} deleted`);
  }
  for (const n of ["w9-cl", "w9-vps", "w9-web", "w9-mon"]) tryIncus("delete", "-f", n);
  await browser.close();
  console.log(fails ? `${fails} FAILED` : "all checks passed");
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
