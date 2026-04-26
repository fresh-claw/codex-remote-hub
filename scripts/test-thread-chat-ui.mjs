#!/usr/bin/env node

import { chromium } from "playwright";

const baseUrl = process.env.THREAD_CHAT_TEST_URL || "http://127.0.0.1:8787";
const password = process.env.THREAD_CHAT_TEST_PASSWORD || "";
const rounds = Math.max(1, Number(process.env.THREAD_CHAT_TEST_ROUNDS || 10));

if (!password) {
  throw new Error("THREAD_CHAT_TEST_PASSWORD is required");
}

function mockView(config = {}) {
  return {
    config: {
      enabled: false,
      intervalMinutes: 15,
      cooldownMinutes: 15,
      maxThreadsPerTick: 2,
      completionPatterns: ["已完成", "完成了", "done", "finished"],
      scripts: [
        {
          id: "night-default",
          name: "夜间继续",
          enabled: true,
          mode: "sequence",
          steps: [
            { condition: "idle", message: "继续" },
            { condition: "idle", message: "进度？" },
            { condition: "idle", message: "请拆下一步并继续执行，完成后说明结果。" },
          ],
        },
      ],
      ...config,
    },
    state: {
      lastTickAt: null,
      updatedAt: null,
      history: [],
    },
    threads: [],
    serverTime: new Date().toISOString(),
  };
}

async function runRound(browser, round) {
  const mobile = round % 2 === 0;
  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1360, height: 900 },
  });
  const page = await context.newPage();
  const errors = [];
  let latest = mockView();

  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await page.route("**/api/chat-ui/autopilot/tick", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sent: [],
        skipped: [],
        serverTime: new Date().toISOString(),
      }),
    });
  });

  await page.route("**/api/chat-ui/autopilot", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(latest),
      });
      return;
    }

    let parsed = {};
    try {
      parsed = JSON.parse(route.request().postData() || "{}");
    } catch {
      parsed = {};
    }
    latest = mockView(parsed.config || parsed);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(latest),
    });
  });

  await page.goto(`${baseUrl}/thread-chat`, { waitUntil: "domcontentloaded" });
  await page.fill("#passwordInput", password);
  await page.click("#loginButton");
  await page.waitForSelector("#appShell:not(.hidden)", { timeout: 12000 });
  await page.click("#autopilotToggleButton");
  await page.waitForSelector("#autopilotPanel:not(.hidden)", { timeout: 5000 });
  await page.click("[data-autopilot-preset=\"progress\"]");
  await page.click("#autopilotAdvancedButton");
  await page.fill("#autopilotIntervalInput", String(5 + round));
  await page.click("#autopilotPowerButton");
  await page.waitForSelector("text=开启", { timeout: 5000 });
  await page.click("#autopilotRunButton");

  const metrics = await page.evaluate(() => {
    const panel = document.querySelector("#autopilotPanel").getBoundingClientRect();
    const shell = document.querySelector(".chat-shell").getBoundingClientRect();
    const run = document.querySelector("#autopilotRunButton").getBoundingClientRect();
    const power = document.querySelector("#autopilotPowerButton").getBoundingClientRect();
    const advanced = document.querySelector("#autopilotAdvancedFields").getBoundingClientRect();
    return {
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 2,
      panelW: Math.round(panel.width),
      shellW: Math.round(shell.width),
      runVisible: run.width > 70 && run.height > 30,
      powerVisible: power.width > 70 && power.height > 30,
      advancedVisible: advanced.width > 0 && advanced.height > 0,
      presetCount: document.querySelectorAll("[data-autopilot-preset]").length,
      activeText: document.querySelector(".preset-chip.active strong")?.textContent || "",
      statusText: document.querySelector("#autopilotStateText")?.textContent || "",
    };
  });

  await context.close();
  const ok = !metrics.overflowX
    && metrics.runVisible
    && metrics.powerVisible
    && metrics.advancedVisible
    && metrics.presetCount === 3
    && metrics.activeText === "进度巡检"
    && metrics.statusText === "开启"
    && errors.length === 0;

  return {
    round,
    viewport: mobile ? "mobile" : "desktop",
    ok,
    ...metrics,
    errors,
  };
}

const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (let round = 1; round <= rounds; round += 1) {
    results.push(await runRound(browser, round));
  }
} finally {
  await browser.close();
}

const failed = results.filter((item) => !item.ok);
console.log(JSON.stringify(results, null, 2));
if (failed.length) {
  throw new Error(`${failed.length} UI rounds failed`);
}
