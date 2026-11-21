// Run: BASE=https://127.0.0.1:8507 INST=w7-t node web/e2e/ws7.spec.js   (needs playwright, admin/review-pass-2026)
// The instance needs: /root/lnk -> /etc/hostname, /root/exist.txt ("data"), /root/t/, /root/full/sub/f, "/root/日本語 é.txt"
const { chromium } = require("playwright");
const { execSync } = require("child_process");
const fs = require("fs");
const BASE = process.env.BASE || "https://127.0.0.1:8507";
const INST = process.env.INST || "w7-t";
const OUT = process.env.OUT || "/tmp/claude-0/ws7";
const sh = (c) => execSync(`incus exec ${INST} -- sh -c '${c}'`).toString();
let fails = 0;
const ok = (c, m) => {
  console.log((c ? "PASS " : "FAIL ") + m);
  if (!c) fails++;
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const b = await chromium.launch();
  const sp = OUT + "/state.json";
  const ctx = await b.newContext({ ignoreHTTPSErrors: true, acceptDownloads: true, viewport: { width: 1200, height: 800 }, ...(fs.existsSync(sp) ? { storageState: sp } : {}) });
  const p = await ctx.newPage();
  await p.goto(BASE + "/");
  await p.waitForTimeout(1000);
  if (await p.locator("input[type=password]").count()) {
    await p.locator("input").first().fill("admin");
    await p.fill("input[type=password]", "review-pass-2026");
    await p.keyboard.press("Enter");
    await p.waitForTimeout(2000);
    await ctx.storageState({ path: sp });
  }
  const url = (t, q = "") => `${BASE}/instances/${process.env.SERVER || "vm"}/${INST}/${t}${q}`;
  // 1 symlink
  await p.goto(url("files", "?path=/root"));
  await p.locator("div.fname", { hasText: "/etc/hostname" }).click();
  await p.waitForSelector("textarea.yaml");
  const val = await p.inputValue("textarea.yaml");
  ok(val.trim() === sh("cat /etc/hostname").trim(), "symlink opens target content, got " + JSON.stringify(val.slice(0, 40)));
  await p.fill("textarea.yaml", "changed\n");
  await p.getByRole("button", { name: "Save" }).click();
  await p.waitForTimeout(1000);
  ok(sh("cat /etc/hostname").trim() === "changed" && sh("readlink /root/lnk").trim() === "/etc/hostname", "save writes target, link intact");
  sh("echo " + INST + " > /etc/hostname");
  // 6 Esc with unsaved changes
  await p.getByText("exist.txt", { exact: true }).click();
  await p.waitForSelector("textarea.yaml");
  await p.fill("textarea.yaml", "zzz");
  await p.keyboard.press("Escape");
  await p.waitForTimeout(500);
  ok(await p.getByText("Discard your changes?").isVisible(), "Esc asks to discard");
  await p.screenshot({ path: OUT + "/discard.png" });
  await p.getByRole("button", { name: "Cancel" }).click();
  ok(await p.locator("textarea.yaml").isVisible(), "cancel keeps editor");
  await p.keyboard.press("Escape");
  await p.waitForTimeout(400);
  await p.getByRole("button", { name: "Discard" }).click();
  await p.waitForTimeout(500);
  // 2 upload conflict
  fs.writeFileSync(OUT + "/exist.txt", "uploaded");
  const up = async (choice) => {
    const [fc] = await Promise.all([p.waitForEvent("filechooser"), p.getByRole("button", { name: "Upload" }).click()]);
    await fc.setFiles(OUT + "/exist.txt");
    await p.waitForSelector("text=exist.txt already exists");
    if (choice === "Cancel") await p.screenshot({ path: OUT + "/clash.png" });
    await p.getByRole("button", { name: choice, exact: true }).click();
    await p.waitForTimeout(1500);
  };
  await up("Cancel");
  ok(sh("cat /root/exist.txt").trim() === "data", "cancel keeps original");
  await up("Keep both");
  ok(sh("cat \"/root/exist (1).txt\"").trim() === "uploaded" && sh("cat /root/exist.txt").trim() === "data", "keep both");
  await up("Replace");
  ok(sh("cat /root/exist.txt").trim() === "uploaded", "replace");
  // 3 download
  // (headless Chromium here ignores non-ASCII filename*, so check the header itself)
  const cd = await p.evaluate(async (u) => (await fetch(u)).headers.get("content-disposition"), `/api/ui/files/${process.env.SERVER || "vm"}/${INST}/download?project=default&path=${encodeURIComponent("/root/日本語 é.txt")}`);
  ok(cd.includes("filename*=UTF-8''%E6%97%A5%E6%9C%AC%E8%AA%9E%20%C3%A9.txt"), "Content-Disposition " + cd);
  const [dl] = await Promise.all([p.waitForEvent("download"), p.locator("tr", { hasText: "exist.txt" }).first().getByLabel("Download").click({ force: true })]);
  ok(dl.suggestedFilename() === "exist.txt", "download button works");
  // 5 new folder
  await p.getByRole("button", { name: "New folder" }).click();
  await p.fill(".dlg input", "t");
  ok(await p.getByText("t already exists here.").isVisible(), "already exists shown");
  await p.fill(".dlg input", "a/b");
  ok(await p.getByText("can't contain /").isVisible(), "slash rejected");
  await p.screenshot({ path: OUT + "/newfolder.png" });
  await p.fill(".dlg input", "newdir");
  await p.keyboard.press("Enter");
  await p.waitForTimeout(1000);
  ok(sh("test -d /root/newdir && echo y").trim() === "y", "folder created");
  // delete non-empty
  await p.locator("tr", { hasText: "full" }).first().getByLabel("Delete").click({ force: true });
  await p.locator(".dlg-f").getByRole("button", { name: "Delete", exact: true }).click();
  await p.waitForTimeout(800);
  await p.screenshot({ path: OUT + "/nonempty.png" });
  ok(await p.getByText("is not empty").first().isVisible(), "offers recursive delete");
  await p.getByRole("button", { name: "Delete everything" }).click();
  await p.waitForTimeout(1200);
  ok(sh("test -e /root/full && echo y || echo n").trim() === "n", "recursive deleted");
  // edit path to a file
  await p.getByRole("button", { name: "Edit path" }).click();
  await p.fill(".toolbar .field input", "/root/exist.txt");
  await p.keyboard.press("Enter");
  await p.waitForSelector("textarea.yaml");
  ok(true, "edit path opens file");
  await p.keyboard.press("Escape");
  await p.waitForTimeout(500);
  // URL / back
  await p.getByText("newdir", { exact: true }).click();
  await p.waitForTimeout(600);
  ok(p.url().includes("path=%2Froot%2Fnewdir"), "path in URL " + p.url());
  await p.goBack();
  await p.waitForTimeout(600);
  ok(p.url().includes("path=%2Froot") && !p.url().includes("newdir"), "back goes up");
  await p.screenshot({ path: OUT + "/files.png" });
  // 4 terminal persistence
  await p.goto(url("terminal"));
  await p.waitForSelector(".xterm-rows");
  await p.waitForTimeout(2500);
  await p.keyboard.type("export W7=alive; echo started-$W7\n");
  await p.waitForTimeout(800);
  await p.getByText("File Explorer", { exact: true }).click();
  await p.waitForTimeout(800);
  await p.getByText("Terminal", { exact: true }).last().click();
  await p.waitForTimeout(800);
  await p.keyboard.type("echo still-$W7\n");
  await p.waitForTimeout(800);
  const txt = await p.locator(".xterm-rows").innerText();
  ok(txt.includes("still-alive"), "shell survived tab switch");
  await p.screenshot({ path: OUT + "/term.png" });
  await p.keyboard.type("exit\n");
  await p.waitForTimeout(2000);
  await p.screenshot({ path: OUT + "/ended0.png" });
  await p.waitForSelector("text=Session ended", { timeout: 8000 });
  await p.screenshot({ path: OUT + "/ended.png" });
  await p.locator(".term-end").getByRole("button", { name: "Reconnect" }).click();
  await p.waitForTimeout(2500);
  await p.keyboard.type("echo back-$((1+1))\n");
  await p.waitForTimeout(800);
  ok((await p.locator(".xterm-rows").innerText()).includes("back-2"), "reconnect works");
  await p.getByRole("button", { name: "Options" }).click();
  await p.fill(".term-opts input[placeholder*=root]", "1000");
  await p.fill(".term-opts input[placeholder='Login shell']", "id -u; sleep 30");
  await p.screenshot({ path: OUT + "/opts.png" });
  await p.getByRole("button", { name: "Connect", exact: true }).click();
  await p.waitForTimeout(2500);
  ok((await p.locator(".xterm-rows").innerText()).includes("1000"), "runs as uid 1000 with command");
  await b.close();
  console.log(fails ? fails + " FAILED" : "ALL OK");
  process.exit(fails ? 1 : 0);
})();
