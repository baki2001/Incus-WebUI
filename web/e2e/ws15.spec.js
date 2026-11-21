const { chromium, BASE, mk } = require("./ws15-lib.cjs");
(async () => {
  const b = await chromium.launch();
  for (const mode of ["light", "phone"]) {
    const { p } = await mk(b, mode);
    await p.goto(BASE + "/networks");
    await p.getByText("incusbr0").first().click();
    await p.waitForTimeout(800);
    await p.getByRole("button", { name: /^Add$/ }).first().click();
    await p.waitForTimeout(800);
    await p.screenshot({ path: `/tmp/fwd-${mode}-1.png` });
    // label link
    console.log(mode, "getByLabel desc:", await p.getByLabel("Description").count());
    const sel = p.getByLabel("Listen address");
    console.log("listen control:", await sel.evaluate((e) => e.tagName));
    // submit empty -> inline errors
    await p.getByRole("button", { name: /^Add$/ }).last().click();
    await p.waitForTimeout(300);
    await p.screenshot({ path: `/tmp/fwd-${mode}-2.png` });
    if (mode !== "light") { await p.close(); continue; }
    // listen address: pick Other, type; default target: type; port 8080 left empty target
    const setAddr = async (label, v) => {
      const c = p.getByLabel(label).first();
      if ((await c.evaluate((e) => e.tagName)) === "SELECT") {
        console.log(label, "options:", await c.locator("option").allTextContents());
        await c.selectOption("__other");
      }
      await p.getByLabel(label).first().fill(v);
    };
    await setAddr("Listen address", "192.0.2.15");
    await setAddr("Target address", "10.115.217.73");
    await p.getByLabel("Listen port").first().fill("8099");
    console.log("port target placeholder:", await p.getByLabel("Target address").last().getAttribute("placeholder"));
    await p.screenshot({ path: `/tmp/fwd-${mode}-3.png` });
    await p.getByRole("button", { name: /^Add$/ }).last().click();
    await p.waitForTimeout(2500);
    await p.screenshot({ path: `/tmp/fwd-${mode}-4.png` });
    await p.close();
  }
  await b.close();
})();
