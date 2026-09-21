import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "@playwright/test";

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  outputDir: process.env.SMC_TEST_OUTPUT_DIR ?? "test-results",
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: {
    timeout: 15_000
  },
  use: {
    trace: "retain-on-failure"
  }
});
