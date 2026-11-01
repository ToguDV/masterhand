import { fireEvent, render, screen } from "@testing-library/react-native"
import { ChoiceModal } from "../src/components/ChoiceModal"

const shortList = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta" },
]

const longList = Array.from({ length: 9 }, (_, index) => ({
  value: `m${index}`,
  label: `Model ${index}`,
}))

describe("ChoiceModal", () => {
  it("lists the options and selects one, closing afterwards", async () => {
    const onSelect = jest.fn()
    const onClose = jest.fn()
    await render(
      <ChoiceModal
        visible
        title="Model"
        options={shortList}
        selected="a"
        onSelect={onSelect}
        onClose={onClose}
      />,
    )

    expect(screen.getByText("Alpha")).toBeOnTheScreen()
    await fireEvent.press(screen.getByText("Beta"))

    expect(onSelect).toHaveBeenCalledWith("b")
    expect(onClose).toHaveBeenCalled()
  })

  it("always offers search, even for short lists", async () => {
    const { rerender } = await render(
      <ChoiceModal visible title="Model" options={shortList} selected="a" onSelect={() => {}} onClose={() => {}} />,
    )
    expect(screen.getByPlaceholderText("Search…")).toBeOnTheScreen()

    await rerender(
      <ChoiceModal visible title="Model" options={longList} selected="a" onSelect={() => {}} onClose={() => {}} />,
    )
    expect(screen.getByPlaceholderText("Search…")).toBeOnTheScreen()
  })

  it("filters a short list too", async () => {
    await render(
      <ChoiceModal visible title="Model" options={shortList} selected="a" onSelect={() => {}} onClose={() => {}} />,
    )
    await fireEvent.changeText(screen.getByPlaceholderText("Search…"), "beta")
    expect(screen.getByText("Beta")).toBeOnTheScreen()
    expect(screen.queryByText("Alpha")).toBeNull()
  })

  it("filters options by the search term and reports no matches", async () => {
    await render(
      <ChoiceModal visible title="Model" options={longList} selected="a" onSelect={() => {}} onClose={() => {}} />,
    )
    const search = screen.getByPlaceholderText("Search…")

    await fireEvent.changeText(search, "model 3")
    expect(screen.getByText("Model 3")).toBeOnTheScreen()
    expect(screen.queryByText("Model 1")).toBeNull()

    await fireEvent.changeText(search, "zzz")
    expect(screen.getByText("No matches")).toBeOnTheScreen()
  })

  it("does not close when pressing inside the sheet", async () => {
    const onClose = jest.fn()
    await render(
      <ChoiceModal visible title="Model" options={shortList} selected="a" onSelect={() => {}} onClose={onClose} />,
    )

    await fireEvent.press(screen.getByText("Model"))

    expect(onClose).not.toHaveBeenCalled()
  })
})
