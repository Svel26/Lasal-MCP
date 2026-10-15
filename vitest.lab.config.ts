import { defineConfig } from "vitest/config";

// Lab tests execute the locally installed LASAL engines against FRESH projects
// created at test time (never shipped example projects, which need upgrades).
// Run with:  npm run test:lab
export default defineConfig({
  test: {
    include: ["test/lab/**/*.lab.test.ts"],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    fileParallelism: false,
    env: { LASAL_LAB: "1" },
  },
});
