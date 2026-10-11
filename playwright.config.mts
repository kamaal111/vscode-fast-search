import { defineConfig } from "@playwright/test";
import type { UiOptions } from "./test/ui/fixtures.js";

const themes = ["dark", "light", "high-contrast"] as const;
export default defineConfig<UiOptions>({
  testDir: "./test/ui",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  workers: 2,
  retries: 0,
  updateSnapshots: "none",
  forbidOnly: Boolean(process.env.CI),
  reporter: [["list"], ["html", { open: "never" }]],
  snapshotPathTemplate: "{testDir}/snapshots/{projectName}/{arg}{ext}",
  expect: { toHaveScreenshot: { animations: "disabled", maxDiffPixels: 50 } },
  use: {
    browserName: "chromium",
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: themes.flatMap((theme) =>
    [320, 180].map((width) => ({
      name: `${theme}-${width}`,
      use: { theme, viewport: { width, height: 480 }, deviceScaleFactor: 1 },
    })),
  ),
  webServer: {
    command: "node --experimental-strip-types test/ui/server.mjs",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
  },
});
