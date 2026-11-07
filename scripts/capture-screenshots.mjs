// Captures the README screenshots from a real, running bb.
//
//   BB_DEMO_PROJECT=proj_… BB_DEMO_THREAD=thr_… npm run screenshots
//
// These are not mockups. Every frame below is Chromium driving a live bb with
// this plugin installed: the same DOM a user sees. What is invented is only the
// *data*: a throwaway bb (its own data folder and ports, for example
// `npx bb-app --data-dir /tmp/demo-bb --server-port 47286 --host-daemon-port 47287`)
// with a few made-up projects and threads, and prompts and snippets added
// through `bb prompts add` and `bb prompts snip-add`. Point the script at it:
//
//   BB_APP_URL=http://127.0.0.1:47286 \
//   BB_DEMO_PROJECT=proj_xxx BB_DEMO_THREAD=thr_xxx npm run screenshots
//
// The demo thread wants three thread prompts (one armed, one scheduled),
// project and global prompts, a few recently used ones, and a snippet titled
// "Debug flaky test {{test}}". PLAYWRIGHT_CHROMIUM points at a Chromium binary
// when Playwright's own download is missing.
//
// Each surface is captured twice, light and dark, so the README can serve the
// right one per reader through <picture>. Dark mode comes from the OS-level
// preference Playwright emulates, which is what bb follows.

import { chromium } from "playwright";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(repoRoot, "assets/screenshots");

// Ids are per instance, so there is no useful default: a stale one would just
// render a 404 into the README. Name the demo thread explicitly.
const APP = process.env.BB_APP_URL ?? "http://127.0.0.1:47286";
const PROJECT = process.env.BB_DEMO_PROJECT;
const THREAD = process.env.BB_DEMO_THREAD;

if (!PROJECT || !THREAD) {
  console.error(
    "Set BB_DEMO_PROJECT and BB_DEMO_THREAD to the seeded demo thread, e.g.\n" +
      "  BB_DEMO_PROJECT=proj_… BB_DEMO_THREAD=thr_… npm run screenshots",
  );
  process.exit(1);
}

const threadUrl = `${APP}/projects/${PROJECT}/threads/${THREAD}`;

// Wide enough that nothing reflows into its narrow layout, narrow enough that
// GitHub's README column does not shrink the type past reading size.
const VIEWPORT = { width: 1280, height: 800 };

const MODES = [
  { suffix: "", colorScheme: "light" },
  { suffix: "-dark", colorScheme: "dark" },
];

/** The app boots, restores the thread, then settles; waiting on the pill beats a fixed nap. */
async function openThread(page) {
  await page.goto(threadUrl, { waitUntil: "load", timeout: 60_000 });
  await page.locator('button[aria-label^="Prompts —"]').waitFor({ timeout: 60_000 });
  // The model picker loads last; a frame with its skeleton looks broken.
  await page
    .locator('button[aria-label^="Provider, model"]')
    .filter({ hasText: /\w/ })
    .first()
    .waitFor({ timeout: 60_000 })
    .catch(() => {});
  await page.waitForTimeout(1_500);
}

/** The smallest rectangle around every match, padded and kept on screen. */
async function clipAround(page, selectors, pad = 24) {
  const boxes = [];
  for (const selector of selectors) {
    const box = await page.locator(selector).first().boundingBox();
    if (box) boxes.push(box);
  }
  if (boxes.length === 0) throw new Error(`nothing to clip: ${selectors.join(", ")}`);
  const viewport = page.viewportSize();
  const x = Math.max(0, Math.min(...boxes.map((b) => b.x)) - pad);
  const y = Math.max(0, Math.min(...boxes.map((b) => b.y)) - pad);
  const right = Math.min(viewport.width, Math.max(...boxes.map((b) => b.x + b.width)) + pad);
  const bottom = Math.min(viewport.height, Math.max(...boxes.map((b) => b.y + b.height)) + pad);
  return { x, y, width: right - x, height: bottom - y };
}

async function shoot(page, name, mode, clip) {
  const path = resolve(outDir, `${name}${mode.suffix}.png`);
  await page.screenshot(clip ? { path, clip } : { path });
  console.log(`  assets/screenshots/${name}${mode.suffix}.png`);
}

const POPOVER = "[data-radix-popper-content-wrapper]";
const COMPOSER = '[data-slot="prompt-box"], form:has([contenteditable="true"])';

async function openQueue(page) {
  await page.locator('button[aria-label^="Prompts —"]').click();
  await page.getByText("Add a regression test").first().waitFor({ timeout: 10_000 });
  await page.waitForTimeout(800);
}

async function openSnippets(page) {
  await page.locator('button[aria-label^="Snippets"]').click();
  await page.getByText("Debug flaky test").first().waitFor({ timeout: 10_000 });
  await page.waitForTimeout(800);
}

const SHOTS = [
  {
    // The whole window: where the queue lives, with the popover open on a
    // thread that has an armed and a scheduled prompt.
    name: "hero",
    viewport: { width: 1280, height: 760 },
    async run(page, mode) {
      await openThread(page);
      await openQueue(page);
      await shoot(page, "hero", mode);
    },
  },
  {
    // The queue popover and the pill that opens it.
    name: "queue",
    async run(page, mode) {
      await openThread(page);
      await openQueue(page);
      await shoot(page, "queue", mode, await clipAround(page, [POPOVER, COMPOSER]));
    },
  },
  {
    // The snippet library, grouped and searchable, fill-in tokens visible.
    name: "snippets",
    async run(page, mode) {
      await openThread(page);
      await openSnippets(page);
      await shoot(page, "snippets", mode, await clipAround(page, [POPOVER, COMPOSER]));
    },
  },
  {
    // A snippet with a {{token}} asks before it goes in, and shows what the
    // agent will actually receive.
    name: "fill-ins",
    async run(page, mode) {
      await openThread(page);
      await openSnippets(page);
      await page.getByText("Debug flaky test {{test}}").first().click();
      const dialog = page.locator('[role="dialog"]').last();
      await dialog.waitFor({ timeout: 10_000 });
      await dialog.locator("input").last().fill("payments/checkout.test.ts");
      const preview = page.getByText("Preview the filled prompt");
      if (await preview.count()) await preview.first().click();
      await page.waitForTimeout(700);
      await shoot(page, "fill-ins", mode, await clipAround(page, ['[role="dialog"] >> nth=-1'], 20));
    },
  },
  {
    // Every queue in one place: the nav panel, sidebar included so it is
    // obvious where it lives.
    name: "manager",
    viewport: { width: 1280, height: 1080 },
    async run(page, mode) {
      await openThread(page);
      await page.getByRole("button", { name: "Prompts", exact: true }).first().click();
      await page.getByText("Recently used", { exact: false }).first().waitFor({ timeout: 10_000 });
      await page.waitForTimeout(1_200);
      // The manager's own column; the sidebar is in the hero already.
      await shoot(page, "manager", mode, { x: 420, y: 0, width: 760, height: 1080 });
    },
  },
  {
    // The same view as a tab in the thread's side panel.
    name: "panel",
    async run(page, mode) {
      await openThread(page);
      await page.locator('button[aria-label^="Show right panel"]').click();
      await page.waitForTimeout(800);
      await page.locator('button[aria-label^="Open new tab"]').click();
      await page.waitForTimeout(800);
      await page.locator("button").filter({ hasText: /^Prompts$/ }).last().click();
      await page.getByText("Add a regression test").last().waitFor({ timeout: 10_000 });
      await page.waitForTimeout(1_000);
      // The side panel tab itself.
      await shoot(page, "panel", mode, { x: 801, y: 0, width: 479, height: 470 });
    },
  },
];

/**
 * The README hero: the full-window shot on a transparent canvas, with a thin
 * border and two faint layers stacked behind it (the plugin's icon, and a
 * queue). Transparent, so it sits on GitHub's own light or dark page.
 */
const FRAMES = {
  light: { suffix: "", border: "#d0d7de", back: "#eef1f4", middle: "#f6f8fa" },
  dark: { suffix: "-dark", border: "#30363d", back: "#1c2128", middle: "#161b22" },
};

async function frameHero(browser) {
  for (const frame of Object.values(FRAMES)) {
    const raw = resolve(outDir, `hero${frame.suffix}.png`);
    const image = (await readFile(raw)).toString("base64");
    const layer = (inset, top, fill) =>
      `<div style="position:absolute;left:${inset}px;right:${inset}px;top:${top}px;height:80px;` +
      `border:1px solid ${frame.border};border-radius:16px;background:${fill}"></div>`;
    const page = await browser.newPage({ viewport: { width: 1240, height: 900 }, deviceScaleFactor: 2 });
    await page.setContent(
      `<body style="margin:0;background:transparent">` +
        `<div id="hero" style="position:relative;width:1240px;padding:44px 20px 4px;box-sizing:border-box">` +
        layer(84, 4, frame.back) +
        layer(52, 24, frame.middle) +
        `<img src="data:image/png;base64,${image}" style="position:relative;display:block;width:100%;` +
        `border:1px solid ${frame.border};border-radius:14px;box-sizing:border-box">` +
        `</div></body>`,
    );
    const path = resolve(repoRoot, `assets/hero${frame.suffix}.png`);
    await page.locator("#hero").screenshot({ path, omitBackground: true });
    await page.close();
    await rm(raw);
    console.log(`  assets/hero${frame.suffix}.png`);
  }
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const only = process.argv.slice(2);
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
  });
  try {
    for (const mode of MODES) {
      console.log(`${mode.colorScheme}:`);
      for (const shot of SHOTS) {
        if (only.length > 0 && !only.includes(shot.name)) continue;
        const ctx = await browser.newContext({
          viewport: shot.viewport ?? VIEWPORT,
          deviceScaleFactor: 2,
          colorScheme: mode.colorScheme,
        });
        // A fresh browser profile would land on bb's first-run setup.
        await ctx.addInitScript(() => {
          window.localStorage.setItem("bb.onboarding.seen", "1");
        });
        const page = await ctx.newPage();
        try {
          await shot.run(page, mode);
        } finally {
          await ctx.close();
        }
      }
    }
    if (only.length === 0 || only.includes("hero")) await frameHero(browser);
  } finally {
    await browser.close();
  }
}

await main();
