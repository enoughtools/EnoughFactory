import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

// The build lands in dist/, which MSBuild zips into the executable as
// Envmux.Portal.zip. Nothing else reads it, so there is no base path to set and
// no manifest to generate — the page is served from the root of whatever
// hostname the session answers on.
//
// `npm run dev` proxies the API to a running session, which is how this is
// worked on: start `envmux` in another terminal, note the port it claimed, and
// point ENVMUX_PORT at it. A session with a token will refuse the dev server's
// requests, so develop against one declaring `"portal": { "token": false }`.
const session = `http://127.0.0.1:${process.env.ENVMUX_PORT ?? 8080}`

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",

    // One file of JavaScript and one of CSS. Code splitting buys a page this
    // size nothing, and every extra request is another round trip before
    // anything is on screen.
    chunkSizeWarningLimit: 1500,
  },
  server: {
    proxy: {
      "/api": { target: session, ws: true, changeOrigin: false },
    },
  },
})
