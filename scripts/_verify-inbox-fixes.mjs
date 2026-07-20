import { chromium } from "playwright";

const BASE = "https://cthalaal.co.za";
const DEMO_EMAIL = "dev@cthalaal.co.za";
const DEMO_PASSWORD = "DemoAdmin#2026";

const browser = await chromium.launch();
const page = await browser.newPage();
try {
  await page.goto(`${BASE}/admin/login`, { waitUntil: "networkidle" });
  await page.fill('input[type="email"]', DEMO_EMAIL);
  await page.fill('input[type="password"]', DEMO_PASSWORD);
  await page.click('button:has-text("Sign in")');
  await page.waitForTimeout(3000);

  await page.goto(`${BASE}/admin/customer-inbox`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500); // let auto-open settle first

  const scrollEl = () => document.querySelector('div.flex-1.overflow-y-auto.px-6');
  const poll = async (label) => {
    const s = await page.evaluate(() => {
      const el = document.querySelector('div.flex-1.overflow-y-auto.px-6');
      if (!el) return null;
      return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
    });
    console.log(label, s, s ? `dist=${s.scrollHeight - s.scrollTop - s.clientHeight}` : "");
    return s;
  };

  await poll("after auto-open (before any click):");

  // Click the SECOND contact in the list — guaranteed different from
  // whatever auto-opened as the first, so this is a genuine thread switch.
  const buttons = page.locator('div.divide-y > button');
  const count = await buttons.count();
  console.log("contact count in list:", count);
  await buttons.nth(1).click();

  // Poll every 250ms for 3s to see the scroll trajectory, not just one snapshot.
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(250);
    await poll(`t+${(i + 1) * 250}ms:`);
  }
} finally {
  await browser.close();
}
