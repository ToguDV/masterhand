import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "@fontsource-variable/fraunces/full.css"
import "@fontsource-variable/instrument-sans/index.css"
import "@fontsource-variable/jetbrains-mono/index.css"
import App from "./App"
import { ToastProvider } from "./components/Toast"
import "./styles.css"

const container = document.getElementById("root")
if (!container) throw new Error("Missing #root in index.html")

createRoot(container).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>,
)
