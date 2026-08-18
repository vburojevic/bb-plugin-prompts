import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// `@bb/plugin-sdk` lives inside the running bb server, not in node_modules;
// the tests only need its two runtime exports.
export default defineConfig({
  resolve: {
    alias: {
      "@bb/plugin-sdk": fileURLToPath(
        new URL("./lib/plugin-sdk-stub.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
  },
});
