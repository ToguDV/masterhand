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

// A file dropped outside the chat must never navigate the window to it (the
// desktop shell would replace the app). The chat column handles its own drops.
const hasFiles = (event: DragEvent): boolean => Array.from(event.dataTransfer?.types ?? []).includes("Files")
window.addEventListener("dragover", (event) => {
  if (hasFiles(event)) event.preventDefault()
})
window.addEventListener("drop", (event) => {
  if (hasFiles(event)) event.preventDefault()
})

createRoot(container).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>,
)
