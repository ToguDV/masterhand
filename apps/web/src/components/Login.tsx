import { useState } from "react"
import type { FormEvent } from "react"
import { ApiError } from "@masterhand/client-core"
import { client } from "../client"
import { BrandMark } from "./BrandMark"
import { Deco } from "./Deco"

export function Login({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await client.auth.login(password)
      setPassword("")
      onSuccess()
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 429) setError("Too many attempts; wait 15 minutes")
        else if (err.status === 401) setError("Wrong password")
        else if (err.status === 400) setError("Enter a password")
        else setError(`Error ${err.status}`)
      } else {
        setError("Could not reach the MasterHand server")
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="mh-login">
      <Deco variant="blob" />
      <Deco variant="dots" />
      <form onSubmit={handleSubmit} className="mh-login-card">
        <div className="mh-brand">
          <BrandMark />
          <span className="mh-brand__name">MasterHand</span>
        </div>
        <p className="mh-body-sm text-ink-muted">Sign in to your self-hosted server.</p>
        <div>
          <label htmlFor="password" className="mh-label">
            Password
          </label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
            autoFocus
            className="mh-input"
          />
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
        <button
          type="submit"
          disabled={busy || password.length === 0}
          className="mh-btn mh-btn--primary w-full"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <p className="mh-caption text-ink-faint">Your data stays on your machine.</p>
      </form>
    </main>
  )
}
