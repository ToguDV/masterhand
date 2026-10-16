import { providerIcon, providerMonogram } from "@masterhand/client-core"

/**
 * Compact provider brand mark for model triggers: the original vendored logo
 * when one exists (ADR-28), otherwise a deterministic monogram. Decorative —
 * the trigger keeps its own accessible name and the full "Provider · Model"
 * label in the tooltip.
 */
export function ProviderGlyph({ providerID, name }: { providerID: string; name: string }) {
  const icon = providerIcon(providerID)
  if (icon) {
    return (
      <span
        aria-hidden="true"
        data-testid="model-provider-glyph"
        className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-ink-soft [&_svg]:h-full [&_svg]:w-full"
        dangerouslySetInnerHTML={{ __html: icon }}
      />
    )
  }
  return (
    <span
      aria-hidden="true"
      data-testid="model-provider-glyph"
      className="shrink-0 text-[11px] font-semibold text-ink-soft"
    >
      {providerMonogram(name)}
    </span>
  )
}
