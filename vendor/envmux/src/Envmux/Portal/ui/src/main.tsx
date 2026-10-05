import { createRoot } from "react-dom/client"

import { App } from "./app"
import "./styles.css"

// No router and no store. There is one page, it shows one session, and the
// session is on the other end of one stream — everything else here is a
// function of that object.
//
// No StrictMode either, and that is a deliberate trade rather than an
// oversight: its double-invoked effects would open every shell twice in
// development, and a shell is a process in somebody's instance rather than a
// subscription that can be created and thrown away for free.
createRoot(document.getElementById("root")!).render(<App />)
