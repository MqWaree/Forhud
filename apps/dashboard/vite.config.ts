import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiProxy = { "/api": "http://localhost:3001" };

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: apiProxy,
  },
  preview: {
    port: 5173,
    proxy: apiProxy,
  },
});
