import { hostname } from "node:os"
import { defineConfig } from "vite"

// Bound to 127.0.0.1 on purpose, and nothing else. From outside the instance
// this server does not exist: its route in .envmux.json fails, and only a
// browser opened with `b` — whose localhost is the instance — reaches it.
// strictPort, because walking to another port would leave the route and the
// ready probe pointing at nothing.
export default defineConfig({
  server: { host: "127.0.0.1", port: 5174, strictPort: true },
  define: {
    __SERVED_BY__: JSON.stringify(hostname()),
    __STARTED_AT__: JSON.stringify(new Date().toISOString()),
  },
})
