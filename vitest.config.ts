import { defineConfig, mergeConfig } from "vitest/config";
import vite from "./vite.config";

/** Unit tests live in src/. bench/ holds its own scenarios and sample projects with their own tests. */
export default mergeConfig(vite, defineConfig({ test: { include: ["src/**/*.test.{ts,tsx}"] } }));
