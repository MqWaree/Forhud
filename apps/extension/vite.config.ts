import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const appRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: fileURLToPath(new URL("popup.html", import.meta.url)),
        background: fileURLToPath(new URL("src/background.ts", import.meta.url)),
        content: fileURLToPath(new URL("src/content.ts", import.meta.url)),
      },
      output: { entryFileNames: "[name].js" },
    },
  },
  root: appRoot,
});
