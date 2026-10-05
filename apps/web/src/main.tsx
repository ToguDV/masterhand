import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import "@fontsource-variable/fraunces/full.css"
import "@fontsource-variable/instrument-sans/index.css"
import "@fontsource-variable/jetbrains-mono/index.css"
import App from "./App"
import { ToastProvider } from "./components/Toast"
import "./styles.css"

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
    },
  },
})

const container = document.getElementById("root")
if (!container) throw new Error("Missing #root in index.html")

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <App />
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
)
