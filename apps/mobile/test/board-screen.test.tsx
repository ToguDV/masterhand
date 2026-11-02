import { Alert } from "react-native"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native"
import * as gestureHandlerMock from "react-native-gesture-handler"
import type { BoardSnapshot, WorkspaceRecord } from "@masterhand/client-core"
import { BoardScreen, autoScrollStep, dropTarget, indexForDrop, indexForPoint } from "../src/screens/BoardScreen"
import { ThemeProvider } from "../src/theme"
import { fakeClient, GestureWrapper, makeQueryClient, QueryWrapper } from "./support/render"

/** Callback shape the board's Pan gesture receives from the handler mock. */
type DragEvent = { absoluteX: number; absoluteY: number; x: number; y: number; translationY?: number }

/** Callbacks captured by the gesture-handler Jest mock (see test/setup.ts). */
const gestureHandlers = (
  gestureHandlerMock as unknown as {
    __gestureHandlers: Record<string, ((event?: DragEvent) => void) | undefined>
  }
).__gestureHandlers

const WORKSPACES: WorkspaceRecord[] = [
  { id: "ws1", name: "demo", path: "/workspaces/demo", createdAt: 0 },
  { id: "ws2", name: "other", path: "/workspaces/other", createdAt: 0 },
]

function makeBoard(): BoardSnapshot {
  return {
    workspaceID: "ws1",
    columns: [
      {
        id: "col_0",
        workspaceID: "ws1",
        title: "To do",
        position: 0,
        createdAt: 0,
        updatedAt: 0,
        cards: [
          { id: "card_0", columnID: "col_0", title: "First", description: "Do it", position: 0, createdAt: 0, updatedAt: 0 },
          { id: "card_1", columnID: "col_0", title: "Second", description: "", position: 1, createdAt: 0, updatedAt: 0 },
        ],
      },
      {
        id: "col_1",
        workspaceID: "ws1",
        title: "Done",
        position: 1,
        createdAt: 0,
        updatedAt: 0,
        cards: [
          { id: "card_2", columnID: "col_1", title: "Third", description: "", position: 0, createdAt: 0, updatedAt: 0 },
        ],
      },
    ],
  }
}

async function setup(
  configure?: (client: ReturnType<typeof fakeClient>) => void,
  props: { workspaceID?: string | null } = {},
) {
  const client = fakeClient()
  client.api.board.get.mockResolvedValue(makeBoard())
  configure?.(client)
  const queryClient = makeQueryClient()
  const handlers = {
    onSelectWorkspace: jest.fn(),
    onAddWorkspace: jest.fn(async () => {}),
    onRemoveWorkspace: jest.fn(),
  }
  function tree(workspaceID: string | null) {
    return (
      <GestureWrapper>
        <QueryWrapper client={queryClient}>
          <ThemeProvider>
            <BoardScreen
              client={client}
              workspaceID={workspaceID}
              workspaces={WORKSPACES}
              onSelectWorkspace={handlers.onSelectWorkspace}
              onAddWorkspace={handlers.onAddWorkspace}
              onRemoveWorkspace={handlers.onRemoveWorkspace}
            />
          </ThemeProvider>
        </QueryWrapper>
      </GestureWrapper>
    )
  }
  const initial = props.workspaceID === undefined ? "ws1" : props.workspaceID
  const { rerender } = await render(tree(initial))
  return {
    client,
    queryClient,
    handlers,
    /** Repoints the mounted board at another workspace, like the picker does. */
    rerenderWorkspace: async (id: string | null) => {
      await rerender(tree(id))
    },
  }
}

/** Presses an Alert button by style (destructive/cancel/default text match). */
async function pressAlertButton(match: (button: { text?: string; style?: string }) => boolean) {
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {})
  return { alert, press: async () => {
    const buttons = alert.mock.calls[0]?.[2] ?? []
    const target = buttons.find(match)
    await act(async () => {
      target?.onPress?.()
    })
  } }
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe("BoardScreen states (#164)", () => {
  it("asks for a workspace when none is open, reusing the workspace bar", async () => {
    await setup(undefined, { workspaceID: null })

    expect(await screen.findByText("Add a workspace first — each workspace has its own board.")).toBeOnTheScreen()

    await fireEvent.press(screen.getByLabelText("Workspace"))
    expect(await screen.findByTestId("workspace-option-ws1")).toBeOnTheScreen()
  })

  it("shows a loading state while the board resolves", async () => {
    await setup((c) => {
      c.api.board.get.mockImplementation(() => new Promise(() => {}))
    })

    expect(screen.getByText("Loading board…")).toBeOnTheScreen()
  })

  it("shows an error with a retry that reloads the board", async () => {
    const { client } = await setup((c) => {
      c.api.board.get.mockRejectedValueOnce(new Error("boom"))
    })

    expect(await screen.findByText("Could not load the board.")).toBeOnTheScreen()

    client.api.board.get.mockResolvedValue(makeBoard())
    await fireEvent.press(screen.getByText("Retry"))
    expect(await screen.findByText("To do")).toBeOnTheScreen()
  })

  it("shows the empty state and validates a new column title", async () => {
    const { client } = await setup((c) => {
      c.api.board.get.mockResolvedValue({ workspaceID: "ws1", columns: [] })
    })

    expect(await screen.findByText(/This workspace has no columns yet/)).toBeOnTheScreen()
    // The first add-column input fills the row: an intrinsic-width input
    // resized the row on every keystroke.
    expect(screen.getByLabelText("New column title")).toHaveStyle({ flex: 1 })

    await fireEvent.press(screen.getByLabelText("Add column"))
    expect(await screen.findByText("Give it a title (1–200 characters)")).toBeOnTheScreen()
    expect(client.api.board.createColumn).not.toHaveBeenCalled()

    await fireEvent.changeText(screen.getByLabelText("New column title"), "To do")
    await fireEvent.press(screen.getByLabelText("Add column"))
    await waitFor(() =>
      expect(client.api.board.createColumn).toHaveBeenCalledWith("ws1", {
        id: expect.any(String),
        title: "To do",
      }),
    )
  })

  it("drops the previous workspace's error when the board is repointed", async () => {
    const { rerenderWorkspace } = await setup((c) => {
      c.api.board.get.mockResolvedValue({ workspaceID: "ws1", columns: [] })
    })

    await screen.findByText(/This workspace has no columns yet/)
    await fireEvent.press(screen.getByLabelText("Add column"))
    expect(await screen.findByText("Give it a title (1–200 characters)")).toBeOnTheScreen()

    await rerenderWorkspace("ws2")
    // The screen stays mounted across the switch; its new empty board must not
    // inherit the failed action from the workspace that was open before.
    expect(await screen.findByText(/This workspace has no columns yet/)).toBeOnTheScreen()
    expect(screen.queryByText("Give it a title (1–200 characters)")).toBeNull()
  })
})

describe("BoardScreen columns and cards (#164)", () => {
  it("renders columns with card counts and cards with descriptions", async () => {
    await setup()

    expect(await screen.findByText("To do")).toBeOnTheScreen()
    expect(screen.getByText("Done")).toBeOnTheScreen()
    expect(screen.getByLabelText("2 cards")).toBeOnTheScreen()
    expect(screen.getByLabelText("1 card")).toBeOnTheScreen()
    expect(screen.getByText("First")).toBeOnTheScreen()
    expect(screen.getByText("Do it")).toBeOnTheScreen()
  })

  it("quick-adds a card to a column", async () => {
    const { client } = await setup()

    await fireEvent.press(await screen.findByLabelText("Add card to To do"))
    expect(await screen.findByText("Give it a title (1–200 characters)")).toBeOnTheScreen()

    await fireEvent.changeText(screen.getByLabelText("New card title in To do"), "Fourth")
    await fireEvent.press(screen.getByLabelText("Add card to To do"))
    await waitFor(() =>
      expect(client.api.board.createCard).toHaveBeenCalledWith({
        id: expect.any(String),
        columnID: "col_0",
        title: "Fourth",
      }),
    )
  })

  it("renames a column inline", async () => {
    const { client } = await setup()

    await fireEvent.press(await screen.findByLabelText("Rename column To do"))
    await fireEvent.changeText(screen.getByLabelText("Column title"), "Up next")
    await fireEvent.press(screen.getByLabelText("Save column title"))

    await waitFor(() => expect(client.api.board.updateColumn).toHaveBeenCalledWith("col_0", { title: "Up next" }))
  })

  it("moves a column from its options", async () => {
    const { client } = await setup()
    const { alert, press } = await pressAlertButton((button) => button.text === "Move left")

    await fireEvent.press((await screen.findAllByLabelText("Column options"))[1]!)
    expect(alert).toHaveBeenCalled()
    await press()

    await waitFor(() => expect(client.api.board.updateColumn).toHaveBeenCalledWith("col_1", { position: 0 }))
    alert.mockRestore()
  })

  it("deletes a column after a confirm that states the card count", async () => {
    const { client } = await setup()
    const options = await pressAlertButton((button) => button.text === "Delete column…")

    await fireEvent.press((await screen.findAllByLabelText("Column options"))[0]!)
    await options.press()
    // The second alert is the delete confirm: title, cascade message, counted action.
    expect(options.alert.mock.calls[1]?.[0]).toBe("Delete column?")
    expect(options.alert.mock.calls[1]?.[1]).toMatch(/"To do" and its 2 cards will be deleted/)
    const confirmButtons = options.alert.mock.calls[1]?.[2] ?? []
    const destructive = confirmButtons.find((button) => button.style === "destructive")
    expect(destructive?.text).toBe("Delete column and 2 cards")
    await act(async () => {
      destructive?.onPress?.()
    })

    await waitFor(() => expect(client.api.board.deleteColumn).toHaveBeenCalledWith("col_0"))
    options.alert.mockRestore()
  })

  it("switches the workspace from the bar", async () => {
    const { handlers } = await setup()

    await fireEvent.press(await screen.findByLabelText("Workspace"))
    await fireEvent.press(await screen.findByText("other"))

    expect(handlers.onSelectWorkspace).toHaveBeenCalledWith("ws2")
  })
})

describe("BoardScreen card editing (#164)", () => {
  it("edits a card title and description", async () => {
    const { client } = await setup()

    await fireEvent.press(await screen.findByLabelText("Edit card First"))
    expect(await screen.findByText("Edit card")).toBeOnTheScreen()
    expect(screen.getByLabelText("Card title").props.value).toBe("First")

    await fireEvent.changeText(screen.getByLabelText("Card title"), "First!")
    await fireEvent.changeText(screen.getByLabelText("Card description"), "Do it now")
    await fireEvent.press(screen.getByLabelText("Save card"))

    await waitFor(() =>
      expect(client.api.board.updateCard).toHaveBeenCalledWith("card_0", {
        title: "First!",
        description: "Do it now",
      }),
    )
  })

  it("rejects an empty card title", async () => {
    const { client } = await setup()

    await fireEvent.press(await screen.findByLabelText("Edit card First"))
    await fireEvent.changeText(screen.getByLabelText("Card title"), "  ")
    await fireEvent.press(screen.getByLabelText("Save card"))

    expect(await screen.findByText("Give it a title (1–200 characters)")).toBeOnTheScreen()
    expect(client.api.board.updateCard).not.toHaveBeenCalled()
  })

  it("moves a card within its column with Move up and Move down", async () => {
    const { client } = await setup()

    await fireEvent.press(await screen.findByLabelText("Edit card Second"))
    await fireEvent.press(await screen.findByLabelText("Move card up"))
    await waitFor(() =>
      expect(client.api.board.updateCard).toHaveBeenCalledWith("card_1", { columnID: "col_0", position: 0 }),
    )

    // Already first: no call.
    client.api.board.updateCard.mockClear()
    await fireEvent.press(await screen.findByLabelText("Edit card First"))
    await fireEvent.press(await screen.findByLabelText("Move card up"))
    expect(client.api.board.updateCard).not.toHaveBeenCalled()

    await fireEvent.press(await screen.findByLabelText("Move card down"))
    await waitFor(() =>
      expect(client.api.board.updateCard).toHaveBeenCalledWith("card_0", { columnID: "col_0", position: 1 }),
    )
  })

  it("moves a card across columns with the Move to picker", async () => {
    const { client } = await setup()

    await fireEvent.press(await screen.findByLabelText("Edit card First"))
    await fireEvent.press(await screen.findByLabelText("Move card to…"))
    expect(await screen.findByText("Move card to…")).toBeOnTheScreen()
    // Only the other columns are offered (the single "To do" is the header behind).
    expect(screen.getAllByText("To do")).toHaveLength(1)

    await fireEvent.press(screen.getByTestId("choice-col_1"))
    await waitFor(() =>
      expect(client.api.board.updateCard).toHaveBeenCalledWith("card_0", { columnID: "col_1", position: 1 }),
    )
  })

  it("hides the Move to picker when there is nowhere else to move", async () => {
    const { client } = await setup((c) => {
      const board = makeBoard()
      c.api.board.get.mockResolvedValue({ ...board, columns: [board.columns[0]!] })
    })

    await fireEvent.press(await screen.findByLabelText("Edit card First"))
    expect(await screen.findByText("Edit card")).toBeOnTheScreen()
    expect(screen.queryByLabelText("Move card to…")).toBeNull()
  })

  it("deletes a card after confirmation", async () => {
    const { client } = await setup()
    const { alert, press } = await pressAlertButton((button) => button.style === "destructive")

    await fireEvent.press(await screen.findByLabelText("Edit card First"))
    await fireEvent.press(await screen.findByLabelText("Delete card"))
    expect(alert).toHaveBeenCalledWith("Delete card?", expect.stringContaining("First"), expect.anything())
    await press()

    await waitFor(() => expect(client.api.board.deleteCard).toHaveBeenCalledWith("card_0"))
    alert.mockRestore()
  })

  it("maps a stale column move to readable copy", async () => {
    const { client } = await setup((c) => {
      c.api.board.updateCard.mockRejectedValue(new Error("column_not_found: gone"))
    })

    await fireEvent.press(await screen.findByLabelText("Edit card First"))
    await fireEvent.press(await screen.findByLabelText("Move card down"))

    expect(await screen.findByText("The column no longer exists — the board was refreshed")).toBeOnTheScreen()
    expect(client.api.board.updateCard).toHaveBeenCalled()
  })

  it("surfaces save, create and delete failures with readable copy", async () => {
    const { client } = await setup((c) => {
      c.api.board.updateCard.mockRejectedValueOnce(new Error("card_not_found: gone"))
      c.api.board.createCard.mockRejectedValueOnce(new Error("boom"))
      c.api.board.deleteColumn.mockRejectedValueOnce(new Error("boom"))
    })

    await fireEvent.press(await screen.findByLabelText("Edit card First"))
    await fireEvent.press(screen.getByLabelText("Save card"))
    expect(
      await screen.findByText("The card no longer exists — the board was refreshed"),
    ).toBeOnTheScreen()
    await fireEvent.press(screen.getByLabelText("Cancel"))

    await fireEvent.changeText(screen.getByLabelText("New card title in To do"), "Fourth")
    await fireEvent.press(screen.getByLabelText("Add card to To do"))
    expect(await screen.findByText("Could not save the board change")).toBeOnTheScreen()
    expect(client.api.board.createCard).toHaveBeenCalled()

    const { alert } = await pressAlertButton(() => false)
    await fireEvent.press((await screen.findAllByLabelText("Column options"))[0]!)
    const optionButtons = alert.mock.calls[0]?.[2] ?? []
    await act(async () => {
      optionButtons.find((button) => button.text === "Delete column…")?.onPress?.()
    })
    // The second alert is the delete confirm, pointed at a failing delete.
    const confirmButtons = alert.mock.calls[1]?.[2] ?? []
    await act(async () => {
      confirmButtons.find((button) => button.style === "destructive")?.onPress?.()
    })
    expect(await screen.findByText("Could not save the board change")).toBeOnTheScreen()
    expect(client.api.board.deleteColumn).toHaveBeenCalledWith("col_0")
    alert.mockRestore()
  })

  it("rejects an empty column rename", async () => {
    const { client } = await setup()

    await fireEvent.press(await screen.findByLabelText("Rename column To do"))
    await fireEvent.changeText(screen.getByLabelText("Column title"), "  ")
    await fireEvent.press(screen.getByLabelText("Save column title"))

    expect(await screen.findByText("Give it a title (1–200 characters)")).toBeOnTheScreen()
    expect(client.api.board.updateColumn).not.toHaveBeenCalled()
  })

  it("adds a column from the end-of-row box and surfaces failures", async () => {
    const { client } = await setup((c) => {
      c.api.board.createColumn.mockRejectedValueOnce(new Error("boom"))
    })
    expect(await screen.findByText("To do")).toBeOnTheScreen()

    await fireEvent.changeText(screen.getByLabelText("New column title"), "Later")
    await fireEvent.press(screen.getByLabelText("Add column"))

    expect(await screen.findByText("Could not save the board change")).toBeOnTheScreen()
    expect(client.api.board.createColumn).toHaveBeenCalledWith("ws1", {
      id: expect.any(String),
      title: "Later",
    })
  })

  it("surfaces rename, move and delete failures with readable copy", async () => {
    const { client } = await setup((c) => {
      c.api.board.updateColumn.mockRejectedValueOnce(new Error("boom"))
    })

    await fireEvent.press(await screen.findByLabelText("Rename column To do"))
    await fireEvent.changeText(screen.getByLabelText("Column title"), "Up next")
    await fireEvent.press(screen.getByLabelText("Save column title"))
    expect(await screen.findByText("Could not save the board change")).toBeOnTheScreen()
    // The failed rename stays open and hides its own options button: cancel first.
    await fireEvent.press(screen.getByLabelText("Cancel rename"))

    client.api.board.updateColumn.mockRejectedValueOnce(new Error("boom"))
    const { alert, press } = await pressAlertButton((button) => button.text === "Move right")
    await fireEvent.press((await screen.findAllByLabelText("Column options"))[0]!)
    await press()
    expect(await screen.findByText("Could not save the board change")).toBeOnTheScreen()
    expect(client.api.board.updateColumn).toHaveBeenCalledWith("col_0", { position: 1 })
    alert.mockRestore()
  })

  it("surfaces a failed card delete with readable copy", async () => {
    const { client } = await setup((c) => {
      c.api.board.deleteCard.mockRejectedValueOnce(new Error("boom"))
    })
    const { alert, press } = await pressAlertButton((button) => button.style === "destructive")

    await fireEvent.press(await screen.findByLabelText("Edit card First"))
    await fireEvent.press(screen.getByLabelText("Delete card"))
    await press()

    expect(await screen.findByText("Could not save the board change")).toBeOnTheScreen()
    expect(client.api.board.deleteCard).toHaveBeenCalledWith("card_0")
    alert.mockRestore()
  })

  it("cancels a column rename without calling the API", async () => {
    const { client } = await setup()

    await fireEvent.press(await screen.findByLabelText("Rename column To do"))
    expect(await screen.findByLabelText("Column title")).toBeOnTheScreen()
    await fireEvent.press(screen.getByLabelText("Cancel rename"))

    expect(screen.queryByLabelText("Column title")).toBeNull()
    expect(client.api.board.updateColumn).not.toHaveBeenCalled()
  })

  it("confirms a workspace removal like the sessions screen", async () => {
    const { handlers } = await setup()

    await fireEvent.press(await screen.findByLabelText("Workspace"))
    await fireEvent.press(await screen.findByText("Remove workspace"))
    await fireEvent.press(await screen.findByLabelText("Remove"))

    expect(handlers.onRemoveWorkspace).toHaveBeenCalledWith("ws1", { deleteFiles: false })
  })
})

describe("BoardScreen drag (#164)", () => {
  beforeEach(() => {
    for (const key of Object.keys(gestureHandlers)) delete gestureHandlers[key]
  })

  it("lifts the card into the board preview and clears it on release", async () => {
    await setup()
    expect(await screen.findByText("Third")).toBeOnTheScreen()

    // The last card rendered owns the shared mocked gesture chain (card_2).
    await act(async () => {
      gestureHandlers.onStart?.({ absoluteX: 200, absoluteY: 300, x: 12, y: 14 })
    })
    // The source card stays in place while the lifted preview renders above it.
    expect(screen.getByText("Third")).toBeOnTheScreen()
    expect(screen.getByTestId("drag-preview", { includeHiddenElements: true })).toBeOnTheScreen()

    await act(async () => {
      gestureHandlers.onUpdate?.({ absoluteX: 220, absoluteY: 340, x: 32, y: 54 })
      gestureHandlers.onEnd?.({ absoluteX: 220, absoluteY: 340, x: 32, y: 54, translationY: 40 })
      gestureHandlers.onFinalize?.()
    })
    expect(screen.queryByTestId("drag-preview", { includeHiddenElements: true })).toBeNull()
    expect(screen.getByText("Third")).toBeOnTheScreen()
  })
})

describe("autoScrollStep (#164 cross-column drag)", () => {
  it("scrolls toward an edge and clamps to the content bounds", () => {
    const viewport = { x: 12, width: 366 }
    // Left edge (trigger zone ends at 56), right edge (starts at 334).
    expect(autoScrollStep(20, viewport, 1000, 100)).toBe(-10)
    expect(autoScrollStep(370, viewport, 1000, 100)).toBe(10)
    expect(autoScrollStep(200, viewport, 1000, 100)).toBe(0)
    // Already at the left edge or the maximum scroll.
    expect(autoScrollStep(20, viewport, 1000, 0)).toBe(0)
    expect(autoScrollStep(370, viewport, 1000, 634)).toBe(0)
    // Content fits the viewport: no scroll.
    expect(autoScrollStep(370, viewport, 300, 0)).toBe(0)
  })
})

describe("indexForDrop (#164)", () => {
  it("maps a drag distance to the slot containing the dragged center", () => {
    const board = makeBoard()
    const cards = board.columns[0]!.cards
    const heights = new Map([
      ["card_0", 60],
      ["card_1", 60],
    ])
    // No movement: stays.
    expect(indexForDrop(cards, 0, 0, heights)).toBe(0)
    // Down past the first row's center: second slot.
    expect(indexForDrop(cards, 0, 40, heights)).toBe(1)
    // Up from the second row: first slot.
    expect(indexForDrop(cards, 1, -40, heights)).toBe(0)
    // Clamped at the ends.
    expect(indexForDrop(cards, 0, 10_000, heights)).toBe(1)
    expect(indexForDrop(cards, 1, -10_000, heights)).toBe(0)
    // Unknown heights fall back to the estimate instead of crashing.
    expect(indexForDrop(cards, 0, 40, new Map())).toBe(1)
    // Unknown card or empty column degrade without a commit index.
    expect(indexForDrop([], 0, 40, heights)).toBe(0)
  })
})

describe("indexForPoint (#164 cross-column drag)", () => {
  it("maps a finger offset inside the card stack to a slot", () => {
    const cards = makeBoard().columns[0]!.cards
    const heights = new Map([
      ["card_0", 60],
      ["card_1", 60],
    ])
    expect(indexForPoint(cards, -20, heights)).toBe(0)
    expect(indexForPoint(cards, 0, heights)).toBe(0)
    expect(indexForPoint(cards, 59, heights)).toBe(0)
    expect(indexForPoint(cards, 60, heights)).toBe(1)
    expect(indexForPoint(cards, 10_000, heights)).toBe(1)
    // An empty column always accepts the card at position 0.
    expect(indexForPoint([], 120, heights)).toBe(0)
    // Unknown heights use the estimate.
    expect(indexForPoint(cards, 70, new Map())).toBe(1)
  })
})

describe("dropTarget (#164 cross-column drag)", () => {
  const columns = makeBoard().columns
  const layouts = new Map([
    ["col_0", { x: 0, width: 280, cardsY: 60 }],
    ["col_1", { x: 292, width: 280, cardsY: 60 }],
  ])
  const heights = new Map([
    ["card_0", 60],
    ["card_1", 60],
    ["card_2", 60],
  ])

  it("resolves the finger to a column and a card slot", () => {
    // Viewport starts at x=12, no scroll. Finger at 12+300 lands in col_1
    // (a single-card column), below its only card.
    expect(
      dropTarget(columns, layouts, { absoluteX: 312, absoluteY: 230, scrollX: 0, viewport: { x: 12, y: 100, width: 366 } }, heights),
    ).toEqual({ columnID: "col_1", position: 0 })

    // Finger over the first card row.
    expect(
      dropTarget(columns, layouts, { absoluteX: 100, absoluteY: 130, scrollX: 0, viewport: { x: 12, y: 100, width: 366 } }, heights),
    ).toEqual({ columnID: "col_0", position: 0 })

    // Below the last card of the source column: last slot.
    expect(
      dropTarget(columns, layouts, { absoluteX: 100, absoluteY: 500, scrollX: 0, viewport: { x: 12, y: 100, width: 366 } }, heights),
    ).toEqual({ columnID: "col_0", position: 1 })
  })

  it("accounts for the horizontal scroll offset", () => {
    // contentX = 100 + 212 - 12 = 300 -> col_1.
    expect(
      dropTarget(columns, layouts, { absoluteX: 212, absoluteY: 170, scrollX: 100, viewport: { x: 12, y: 100, width: 366 } }, heights),
    ).toEqual({ columnID: "col_1", position: 0 })
  })

  it("snaps a drop in the gap to the nearest column", () => {
    // contentX = 290, 2px above col_1's left edge.
    expect(
      dropTarget(columns, layouts, { absoluteX: 302, absoluteY: 170, scrollX: 0, viewport: { x: 12, y: 100, width: 366 } }, heights),
    ).toEqual({ columnID: "col_1", position: 0 })
    // contentX = 200, deep inside col_0.
    expect(
      dropTarget(columns, layouts, { absoluteX: 212, absoluteY: 170, scrollX: 0, viewport: { x: 12, y: 100, width: 366 } }, heights),
    ).toEqual({ columnID: "col_0", position: 0 })
  })

  it("returns null until the viewport and column layouts are measured", () => {
    expect(
      dropTarget(columns, new Map(), { absoluteX: 100, absoluteY: 130, scrollX: 0, viewport: { x: 12, y: 100, width: 366 } }, heights),
    ).toBeNull()
    expect(
      dropTarget(columns, layouts, { absoluteX: 100, absoluteY: 130, scrollX: 0, viewport: { x: 0, y: 0, width: 0 } }, heights),
    ).toBeNull()
  })

  it("drops into an empty destination at position 0", () => {
    const empty = makeBoard()
    empty.columns[1]!.cards = []
    expect(
      dropTarget(empty.columns, layouts, { absoluteX: 312, absoluteY: 230, scrollX: 0, viewport: { x: 12, y: 100, width: 366 } }, heights),
    ).toEqual({ columnID: "col_1", position: 0 })
  })
})
