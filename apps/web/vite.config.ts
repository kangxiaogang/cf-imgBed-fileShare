import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [svelte(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/-": "http://127.0.0.1:8787",
      "/img": "http://127.0.0.1:8787",
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
