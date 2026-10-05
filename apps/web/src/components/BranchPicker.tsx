import { useMemo, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  branchErrorMessage,
  isAmbiguousError,
  queryKeys,
  useBranches,
  type GitBranches,
} from "@masterhand/client-core"
import { client } from "../client"
import { useDismissable } from "./useDismissable"
import { BranchIcon, CheckIcon, ChevronDownIcon } from "./icons"

/**
 * Branch chip for standard (non-isolated) sessions: shows the workspace's
 * current branch and opens a popover with search, switch and create-from-current
 * (issue #94). Isolated sessions get the read-only chip from `ChatView` instead.
 *
 * `create`/`checkout` are non-idempotent: a timeout is surfaced as "may have
 * applied", the list is refetched to reconcile, and the action is never retried
 * automatically (docs/past-mistakes.md rule 4).
 */
export function BranchPicker({ workspaceID }: { workspaceID: string }) {
  const queryClient = useQueryClient()
  const branchesQuery = useBranches(client, true, workspaceID)
  const info = branchesQuery.data
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  useDismissable(open, rootRef, () => setOpen(false))
  const [search, setSearch] = useState("")
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const branches = useMemo(() => {
    const needle = search.trim().toLowerCase()
    const list = info?.branches ?? []
    return needle ? list.filter((branch) => branch.toLowerCase().includes(needle)) : list
  }, [info, search])

  async function refresh(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: queryKeys.branches(workspaceID) })
  }

  async function run(action: () => Promise<GitBranches>, describe: (result: GitBranches) => string) {
    if (busy) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await action()
      setNotice(describe(result))
      setName("")
      await refresh()
    } catch (caught) {
      setError(branchErrorMessage(caught))
      // A timeout means the mutation may have applied: reconcile, don't retry.
      if (isAmbiguousError(caught)) await refresh()
    } finally {
      setBusy(false)
    }
  }

  const current = info?.current ?? null

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={!info}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Branch"
        title={current ? `Branch: ${current}` : "Loading branch…"}
        className="flex min-w-0 max-w-[14rem] cursor-pointer items-center gap-1.5 rounded-sm border border-hairline-strong bg-surface px-2.5 py-1.5 outline-none transition-colors hover:bg-surface-muted focus-visible:border-accent disabled:opacity-60"
      >
        <BranchIcon size={14} className="shrink-0 text-ink-muted" />
        <span className="truncate font-mono text-xs text-ink-soft">{current ?? "…"}</span>
        <ChevronDownIcon size={14} className="shrink-0 text-ink-muted" />
      </button>

      {open && info && (
        <div
          role="dialog"
          aria-label="Branch"
          className="absolute bottom-full left-0 z-30 mb-2 w-72 max-w-[85vw] rounded-md border border-hairline bg-surface p-2 shadow-elev3"
        >
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search branches"
            aria-label="Search branches"
            className="mb-2 w-full rounded-sm border border-hairline-strong bg-surface px-2 py-1.5 text-xs text-ink outline-none placeholder:text-ink-faint focus:border-accent"
          />
          <ul role="listbox" aria-label="Branches" className="max-h-56 space-y-0.5 overflow-y-auto">
            {branches.map((branch) => {
              const active = branch === current
              return (
                <li key={branch}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={active}
                    disabled={busy || active}
                    onClick={() => void run(() => client.api.branches.checkout(workspaceID, branch), () => `Switched to ${branch}`)}
                    className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left font-mono text-xs hover:bg-surface-muted disabled:opacity-70 ${
                      active ? "text-ink" : "text-ink-soft"
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate">{branch}</span>
                    {active && <CheckIcon size={14} className="shrink-0 text-accent" />}
                  </button>
                </li>
              )
            })}
            {branches.length === 0 && <li className="px-2 py-3 text-xs text-ink-muted">No matches</li>}
          </ul>

          <div className="my-2 h-px bg-hairline" />
          <form
            className="space-y-1.5"
            onSubmit={(event) => {
              event.preventDefault()
              const value = name.trim()
              if (!value) return
              void run(() => client.api.branches.create(workspaceID, value), () => `Created and switched to ${value}`)
            }}
          >
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="new-branch-name"
                aria-label="New branch name"
                className="min-w-0 flex-1 rounded-sm border border-hairline-strong bg-surface px-2 py-1.5 font-mono text-xs text-ink outline-none placeholder:text-ink-faint focus:border-accent"
              />
              <button
                type="submit"
                disabled={busy || name.trim().length === 0}
                className="mh-btn mh-btn--secondary mh-btn--sm shrink-0"
              >
                Create
              </button>
            </div>
            <p className="px-0.5 text-[11px] text-ink-muted">Creates and switches from {current}</p>
          </form>

          {error && <p className="mt-2 text-[11px] text-danger">{error}</p>}
          {notice && <p className="mt-2 text-[11px] text-ink-muted">{notice}</p>}
        </div>
      )}
    </div>
  )
}

/** Read-only branch chip for isolated sessions (their branch is worktree-owned). */
export function BranchChip({ branch }: { branch: string }) {
  return (
    <span className="mh-chip mh-chip--mono max-w-[14rem] truncate" title={branch}>
      <BranchIcon size={12} className="mr-1 inline-block align-text-bottom" />
      {branch}
    </span>
  )
}
