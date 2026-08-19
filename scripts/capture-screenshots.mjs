// Captures the README screenshots from a real, running BB.
//
//   npm run screenshots
//
// These are not mockups. Every frame below is Chromium driving a live BB with
// this plugin installed — the same DOM a user sees. What is fake is only the
// *data*: a throwaway BB dev instance (`scripts/bb-dev-app current` in the bb
// checkout, its own data dir and ports) seeded with an invented project, a few
// invented threads, and the prompts and snippets listed in seed().
//
// Point it somewhere else with:
//   BB_APP_URL=http://localhost:16581 \
//   BB_DEMO_PROJECT=proj_xxx BB_DEMO_THREAD=thr_xxx npm run screenshots
//
// Each surface is captured twice, light and dark, so the README can serve the
// right one per reader via <picture>. Dark mode comes from the OS-level
// preference Playwright emulates, which is what BB follows.

import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(repoRoot, "assets/screenshots");

// Ids are per-instance, so there is no useful default: a stale one would just
// render a 404 into the README. Name the demo thread explicitly.
const APP = process.env.BB_APP_URL ?? "http://localhost:16581";
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
// GitHub's ~830px README column does not shrink the type past reading size.
const VIEWPORT = { width: 1280, height: 840 };

const MODES = [
  { suffix: "", colorScheme: "light" },
  { suffix: "-dark", colorScheme: "dark" },
];

/** The app boots, restores the thread, then settles; polling beats a fixed nap. */
async function openThread(page) {
  await page.goto(threadUrl, { waitUntil: "networkidle", timeout: 60_000 });
  await page.locator('button[aria-label^="Prompts —"]').waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1_500);
}

/** Everything right of the sidebar: the plugin's surfaces, none of the chrome. */
async function contentClip(page) {
  const sidebar = await page.evaluate(() => {
    const el = document.querySelector('[data-slot="sidebar-container"], [data-sidebar="sidebar"]');
    return el ? el.getBoundingClientRect().right : 228;
  });
  return {
    x: sidebar,
    y: 0,
    width: VIEWPORT.width - sidebar,
    height: VIEWPORT.height,
  };
}

async function shoot(page, name, mode, clip) {
  const path = resolve(outDir, `${name}${mode.suffix}.png`);
  await page.screenshot(clip ? { path, clip } : { path });
  console.log(`  assets/screenshots/${name}${mode.suffix}.png`);
}

const SHOTS = [
  {
    // The queue itself: three prompts for this thread, one armed, one booked
    // for a time, with the project and global queues one tab away.
    name: "queue",
    async run(page, mode) {
      await openThread(page);
      await page.locator('button[aria-label^="Prompts —"]').click();
      await page.waitForTimeout(1_200);
      await shoot(page, "queue", mode, await contentClip(page));
    },
  },
  {
    // The snippet library, grouped and searchable, fill-in tokens visible.
    name: "snippets",
    async run(page, mode) {
      await openThread(page);
      await page.locator('button[aria-label^="Snippets"]').click();
      await page.waitForTimeout(1_200);
      await shoot(page, "snippets", mode, await contentClip(page));
    },
  },
  {
    // A snippet with a {{token}} asks before it goes in, and shows what the
    // agent will actually receive.
    name: "fill-ins",
    async run(page, mode) {
      await openThread(page);
      await page.locator('button[aria-label^="Snippets"]').click();
      await page.waitForTimeout(900);
      await page.getByText("Debug flaky test {{test}}").first().click();
      await page.waitForTimeout(900);
      const field = page.locator('[role="dialog"] input').last();
      await field.fill("payments/checkout.test.ts");
      await page.getByText("Preview the filled prompt").click();
      await page.waitForTimeout(700);
      await shoot(page, "fill-ins", mode);
    },
  },
  {
    // Every queue in one place — the nav panel, sidebar included so it is
    // obvious where it lives. Taller, because the point of this shot is that
    // all of it fits on one screen.
    name: "manager",
    viewport: { width: 1280, height: 1040 },
    async run(page, mode) {
      await openThread(page);
      await page.getByRole("button", { name: "Prompts", exact: true }).click();
      await page.waitForTimeout(2_000);
      await shoot(page, "manager", mode);
    },
  },
];

async function main() {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const mode of MODES) {
      console.log(`${mode.colorScheme}:`);
      for (const shot of SHOTS) {
        const ctx = await browser.newContext({
          viewport: shot.viewport ?? VIEWPORT,
          deviceScaleFactor: 2,
          colorScheme: mode.colorScheme,
        });
        const page = await ctx.newPage();
        try {
          await shot.run(page, mode);
        } finally {
          await ctx.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
}

await main();
