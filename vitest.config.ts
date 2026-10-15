import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["packages/*/test/*.test.ts", "services/*/test/*.test.ts", "apps/*/test/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts", "services/*/test/integration/**/*.test.ts"],
          environment: "node",
          testTimeout: 60_000,
          hookTimeout: 180_000,
          fileParallelism: false,
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
          globalSetup: ["test/integration/global-setup.ts"],
        },
      },
    ],
  },
});
