import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: the API runs on PORT (default 7828, npm start); /api is proxied, so the browser talks to one origin (same-origin writes).
const api = { target: `http://127.0.0.1:${Number(process.env.PORT) || 7828}` };

export default defineConfig({
  plugins: [react()],
  server: { host: "127.0.0.1", port: Number(process.env.VITE_PORT) || 7801, strictPort: false, proxy: { "/api": api } },
  test: { environment: "jsdom", globals: true, setupFiles: "./src/testSetup.js" },
});
