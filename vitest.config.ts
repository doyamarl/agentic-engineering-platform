import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["{apps,packages,adapters,workflow-packs,architecture,tools}/**/*.test.ts"],
    exclude: ["**/node_modules/**", "architecture/fixtures/**"],
  },
});
