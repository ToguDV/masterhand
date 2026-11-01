// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ChatToolPart, FormInfo } from "@masterhand/client-core"
import { QuestionCard } from "../src/components/QuestionCard"

afterEach(cleanup)

function questionPart(state: Partial<ChatToolPart["state"]> = {}): ChatToolPart {
  return {
    id: "p-q",
    sessionID: "s1",
    messageID: "m1",
    type: "tool",
    tool: "question",
    callID: "c1",
    state: { status: "running", input: {}, ...state },
  }
}

function form(
  fields: FormInfo["fields"],
  metadata: FormInfo["metadata"] = { kind: "question", tool: { messageID: "m1", id: "c1" } },
): FormInfo {
  return {
    id: "frm_1",
    sessionID: "s1",
    title: "Questions",
    fields,
    metadata,
  }
}

describe("QuestionCard", () => {
  it("never attaches a newer pending question to an older answered part", () => {
    const answeredForm = form(
      [{ key: "db", type: "string", title: "Database" }],
      { kind: "question", tool: { messageID: "m1", id: "c1" } },
    )
    const newerForm: FormInfo = {
      ...form(
        [{ key: "lang", type: "string", title: "Language", options: [{ label: "TypeScript", value: "ts" }] }],
        { kind: "question", tool: { messageID: "m2", id: "c2" } },
      ),
      id: "frm_2",
    }

    render(
      <QuestionCard
        part={questionPart({ status: "completed" })}
        forms={[newerForm]}
        answeredForms={[{ form: answeredForm, answer: { db: "pg" } }]}
        busyFormID={null}
        onRespond={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    expect(screen.getByTestId("question-answered")).toBeTruthy()
    expect(screen.getByText("pg")).toBeTruthy()
    expect(screen.queryByText("Language")).toBeNull()
    expect(screen.queryByText("TypeScript")).toBeNull()
  })

  it("never attaches a newer pending question to an older part without a local answer", () => {
    const newerForm: FormInfo = {
      ...form(
        [{ key: "lang", type: "string", title: "Language", options: [{ label: "TypeScript", value: "ts" }] }],
        { kind: "question", tool: { messageID: "m2", id: "c2" } },
      ),
      id: "frm_2",
    }

    render(
      <QuestionCard
        part={questionPart({ status: "completed", output: "Answered: postgres" })}
        forms={[newerForm]}
        answeredForms={[]}
        busyFormID={null}
        onRespond={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    expect(screen.getByText("Answered: postgres")).toBeTruthy()
    expect(screen.queryByText("Language")).toBeNull()
    expect(screen.queryByText("TypeScript")).toBeNull()
  })

  it("keeps the single-pending fallback for legacy forms without tool metadata", () => {
    const info = form([{ key: "name", type: "string", title: "Name" }], { kind: "question" })

    render(
      <QuestionCard
        part={questionPart()}
        forms={[info]}
        answeredForms={[]}
        busyFormID={null}
        onRespond={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    expect(screen.getByTestId("question-card")).toBeTruthy()
    expect(screen.getByText("Name")).toBeTruthy()
  })
})
