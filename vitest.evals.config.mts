import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

/** Live evals: real Groq + weather APIs, run sequentially and paced for free-tier limits. */
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["evals/**/*.eval.ts"],
    env: loadEnv("", process.cwd(), ""),
    testTimeout: 60 * 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    reporters: ["verbose"],
  },
});
