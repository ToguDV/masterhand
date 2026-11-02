import { fireEvent, render, screen } from "@testing-library/react-native"
import { SearchSelect } from "../src/components/SearchSelect"

const shortList = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta" },
]

const longList = Array.from({ length: 9 }, (_, index) => ({
  value: `m${index}`,
  label: `Model ${index}`,
}))

describe("SearchSelect", () => {
  it("shows the placeholder until a value is selected", async () => {
    await render(
      <SearchSelect value="" options={shortList} onChange={() => {}} ariaLabel="Agent" placeholder="agent…" />,
    )

    expect(screen.getByLabelText("Agent")).toBeOnTheScreen()
    expect(screen.getByText("agent…")).toBeOnTheScreen()
  })

  it("shows the compact trigger label instead of the full list label", async () => {
    await render(
      <SearchSelect
        value="p/m"
        options={[{ value: "p/m", label: "Provider · Model", triggerLabel: "Model" }]}
        onChange={() => {}}
        ariaLabel="Model"
        placeholder="model…"
      />,
    )

    expect(screen.getByText("Model")).toBeOnTheScreen()
    expect(screen.queryByText("Provider · Model")).toBeNull()
  })

  it("lists the options and selects one, closing afterwards", async () => {
    const onChange = jest.fn()
    await render(
      <SearchSelect value="a" options={shortList} onChange={onChange} ariaLabel="Agent" placeholder="agent…" />,
    )

    await fireEvent.press(screen.getByLabelText("Agent"))
    await fireEvent.press(screen.getByText("Beta"))

    expect(onChange).toHaveBeenCalledWith("b")
    expect(screen.queryByText("Beta")).toBeNull()
  })

  it("only offers search for long lists", async () => {
    const { rerender } = await render(
      <SearchSelect value="" options={shortList} onChange={() => {}} ariaLabel="Model" placeholder="model…" />,
    )
    await fireEvent.press(screen.getByLabelText("Model"))
    expect(screen.queryByPlaceholderText("Search…")).toBeNull()

    await fireEvent.press(screen.getByText("Alpha"))
    await rerender(
      <SearchSelect value="" options={longList} onChange={() => {}} ariaLabel="Model" placeholder="model…" />,
    )
    await fireEvent.press(screen.getByLabelText("Model"))
    expect(screen.getByPlaceholderText("Search…")).toBeOnTheScreen()
  })

  it("filters options by the search term and reports no matches", async () => {
    await render(
      <SearchSelect value="" options={longList} onChange={() => {}} ariaLabel="Model" placeholder="model…" />,
    )

    await fireEvent.press(screen.getByLabelText("Model"))
    const search = screen.getByPlaceholderText("Search…")

    await fireEvent.changeText(search, "model 3")
    expect(screen.getByText("Model 3")).toBeOnTheScreen()
    expect(screen.queryByText("Model 1")).toBeNull()

    await fireEvent.changeText(search, "zzz")
    expect(screen.getByText("No matches")).toBeOnTheScreen()
  })

  it("previews six options and expands with Show all", async () => {
    await render(
      <SearchSelect value="" options={longList} onChange={() => {}} ariaLabel="Model" placeholder="model…" />,
    )

    await fireEvent.press(screen.getByLabelText("Model"))

    expect(screen.getByText("Model 5")).toBeOnTheScreen()
    expect(screen.queryByText("Model 6")).toBeNull()

    await fireEvent.press(screen.getByText("Show all 9 models"))
    expect(screen.getByText("Model 8")).toBeOnTheScreen()
  })

  it("closes from the scrim", async () => {
    await render(
      <SearchSelect value="" options={shortList} onChange={() => {}} ariaLabel="Agent" placeholder="agent…" />,
    )

    await fireEvent.press(screen.getByLabelText("Agent"))
    await fireEvent.press(screen.getByLabelText("Close menu"))

    expect(screen.queryByText("Alpha")).toBeNull()
  })

  it("selects the first filtered option on submit", async () => {
    const onChange = jest.fn()
    await render(
      <SearchSelect value="" options={longList} onChange={onChange} ariaLabel="Model" placeholder="model…" />,
    )

    await fireEvent.press(screen.getByLabelText("Model"))
    const search = screen.getByPlaceholderText("Search…")
    await fireEvent.changeText(search, "model 3")
    await fireEvent(search, "submitEditing")

    expect(onChange).toHaveBeenCalledWith("m3")
  })

  it("does not open while disabled", async () => {
    await render(
      <SearchSelect
        value=""
        options={shortList}
        onChange={() => {}}
        ariaLabel="Effort"
        placeholder="Default"
        disabled
      />,
    )

    await fireEvent.press(screen.getByLabelText("Effort"))

    expect(screen.queryByText("Alpha")).toBeNull()
  })
})
