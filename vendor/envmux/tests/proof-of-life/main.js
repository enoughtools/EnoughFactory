// What this page can prove about how it was reached. "Served by" is the
// machine Vite runs on, which is the instance's hostname when this came
// through the session's proxy. The HMR line is the WebSocket, carried by the
// same relay. The font came from Google, from the workstation.

const set = (id, text, good) => {
  const element = document.getElementById(id)
  element.textContent = text
  if (good !== undefined) element.className = good ? "good" : "bad"
}

set("served-by", `${__SERVED_BY__} (dev server started ${__STARTED_AT__})`)
set("origin", location.origin)

if (import.meta.hot) {
  import.meta.hot.on("vite:ws:connect", () => set("hmr", "connected", true))
  import.meta.hot.on("vite:ws:disconnect", () => set("hmr", "lost", false))
} else {
  set("hmr", "not a dev build", false)
}

document.fonts.ready.then(() =>
  set("font", document.fonts.check('1em "Lobster"') ? "loaded from Google" : "not loaded", document.fonts.check('1em "Lobster"')),
)
