import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  base: "./",
  resolve: {
    alias: { "@": resolve(import.meta.dirname, "src") },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    minify: false,
    rollupOptions: {
      input: {
        graph: resolve(import.meta.dirname, "panel/graph.html"),
        diff: resolve(import.meta.dirname, "panel/diff.html"),
      },
    },
  },
});
