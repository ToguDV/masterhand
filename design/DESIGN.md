---
version: alpha
name: MasterHand-design-analysis
description: 'MasterHand speaks in ''ink on paper'' — a near-monochrome black-and-white editorial system with a single deep-emerald accent, classical display serif for brand moments, and organic decoration (soft blobs, halftone dot fields, line hatching, thin curved lines) reserved for surfaces that would otherwise feel empty. The system covers both light and dark themes as equal citizens across web, desktop and mobile, with the chat surface as the product''s centerpiece. Mobile-first by rule: every layout is designed at 360–430px first and only then expanded.'
colors:
  # Neutral ramps (shared by both themes)
  paper: "#FAFAF7"
  white: "#FFFFFF"
  ink-950: "#0C0C0B"
  ink-900: "#141413"
  ink-800: "#1C1C1A"
  ink-700: "#262624"
  ink-600: "#3A3A37"
  ink-500: "#4A4A46"
  grey-500: "#6E6E6A"
  grey-400: "#8E8E88"
  grey-300: "#B4B4AE"
  grey-200: "#D6D6D0"
  grey-100: "#E8E8E2"
  grey-50: "#F2F2EE"
  # Deep-emerald accent ramp
  emerald-900: "#06372C"
  emerald-800: "#085041"
  emerald-700: "#0B6B53"
  emerald-600: "#0E7F63"
  emerald-500: "#17A67C"
  emerald-400: "#2FBE96"
  emerald-300: "#3ED8A8"
  emerald-200: "#8BE9C9"
  emerald-100: "#D9EAE3"
  emerald-50: "#EAF4F0"
  # Semantic tokens — LIGHT theme values. Dark overrides: see the Colors section and design.css.
  canvas: "#FAFAF7"
  surface: "#FFFFFF"
  surface-muted: "#F2F2EE"
  text: "#0C0C0B"
  text-soft: "#4A4A46"
  text-muted: "#6E6E6A"
  text-faint: "#8E8E88"
  hairline: "#E8E8E2"
  hairline-strong: "#D6D6D0"
  accent: "#0B6B53"
  accent-strong: "#085041"
  accent-soft: "#D9EAE3"
  accent-line: "rgba(11, 107, 83, 0.35)"
  on-accent: "#FFFFFF"
  bubble-user: "#085041"
  bubble-user-text: "#FFFFFF"
  success: "#0B6B53"
  warning: "#8A5A00"
  warning-soft: "rgba(138, 90, 0, 0.09)"
  warning-line: "rgba(138, 90, 0, 0.32)"
  danger: "#B3261E"
  danger-soft: "rgba(179, 38, 30, 0.08)"
  danger-line: "rgba(179, 38, 30, 0.32)"
  code-surface: "#141413"
  code-surface-soft: "#1C1C1A"
  code-text: "#EDEDE8"
  code-muted: "#8E8E88"
  overlay: "rgba(12, 12, 11, 0.45)"
typography:
  display-hero:
    fontFamily: Fraunces
    fontSize: 56px
    fontWeight: 400
    lineHeight: 1.05
    letterSpacing: -0.02em
  display-lg:
    fontFamily: Fraunces
    fontSize: 42px
    fontWeight: 400
    lineHeight: 1.08
    letterSpacing: -0.02em
  heading-1:
    fontFamily: Fraunces
    fontSize: 32px
    fontWeight: 400
    lineHeight: 1.15
    letterSpacing: -0.01em
  heading-2:
    fontFamily: Fraunces
    fontSize: 26px
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: -0.01em
  heading-3:
    fontFamily: Instrument Sans
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.3
  heading-4:
    fontFamily: Instrument Sans
    fontSize: 17px
    fontWeight: 600
    lineHeight: 1.35
  body-lg:
    fontFamily: Instrument Sans
    fontSize: 17px
    fontWeight: 400
    lineHeight: 1.6
  body-md:
    fontFamily: Instrument Sans
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.6
  body-md-medium:
    fontFamily: Instrument Sans
    fontSize: 15px
    fontWeight: 500
    lineHeight: 1.6
  body-sm:
    fontFamily: Instrument Sans
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.5
  caption:
    fontFamily: Instrument Sans
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.45
  micro:
    fontFamily: Instrument Sans
    fontSize: 11px
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: 0.08em
  button:
    fontFamily: Instrument Sans
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.2
  wordmark:
    fontFamily: Fraunces
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: -0.01em
  code-md:
    fontFamily: JetBrains Mono
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.6
  code-sm:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
rounded:
  xs: 6px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 20px
  xxl: 24px
  full: 9999px
spacing:
  xxs: 4px
  xs: 8px
  sm: 12px
  md: 16px
  lg: 20px
  xl: 24px
  xxl: 32px
  xxxl: 40px
  section-sm: 48px
  section: 64px
  section-lg: 96px
  hero: 112px
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: "10px 18px"
    height: 44px
  button-primary-pressed:
    backgroundColor: "{colors.accent-strong}"
    textColor: "{colors.on-accent}"
  button-primary-disabled:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.text-faint}"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: "10px 18px"
    border: "1px solid {colors.hairline-strong}"
    height: 44px
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-muted}"
    typography: "{typography.button}"
    rounded: "{rounded.sm}"
    padding: "8px 12px"
  button-danger:
    backgroundColor: "{colors.danger-soft}"
    textColor: "{colors.danger}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: "10px 18px"
    border: "1px solid {colors.danger-line}"
  button-icon:
    backgroundColor: "transparent"
    textColor: "{colors.text-muted}"
    rounded: "{rounded.sm}"
    padding: "0"
    size: "40x40 (44x44 on touch)"
  text-field:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.text}"
    typography: "{typography.body-md}"
    rounded: "{rounded.sm}"
    padding: "10px 12px"
    border: "1px solid transparent"
    height: 44px
    caret: "{colors.accent}"
  text-field-focused:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.text}"
    border: "1px solid {colors.text-muted}"
    ring: "0 0 0 3px color-mix(in srgb, {colors.text-muted} 12%, transparent)"
  text-area:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.text}"
    typography: "{typography.body-md}"
    rounded: "{rounded.md}"
    padding: "{spacing.sm} {spacing.md}"
    border: "1px solid transparent"
    resize: "none (fields grow with their content; the native grip is UA-drawn and does not follow the dark theme)"
  select-trigger:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.text}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.sm}"
    padding: "6px 10px"
    border: "1px solid transparent"
  search-field:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.text}"
    typography: "{typography.body-md}"
    rounded: "{rounded.lg}"
    padding: "10px 12px 10px 36px"
    border: "1px solid transparent"
  composer-bar:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.body-md}"
    padding: "{spacing.sm} {spacing.md} {spacing.md}"
    border: "1px solid {colors.hairline}"
    rounded: "{rounded.lg}"
    shadow: "level 1 resting, no focus ring (the dock stays quiet on focus)"
    geometry: "one dock card: context bar (workspace menu, read-only branch viewer, stats) as the head with a bottom hairline, borderless message field, and the agent/model/effort/auto-accept/send toolbar integrated below it. The Goal Mode control line renders just above the composer, constrained to the chat column width"
  top-bar:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.text}"
    typography: "{typography.body-md-medium}"
    padding: "0 {spacing.md}"
    border: "1px solid {colors.hairline} (bottom)"
    height: 56px
  bottom-nav:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.text-muted}"
    typography: "{typography.caption}"
    padding: "2px {spacing.xxs} 0"
    border: "1px solid {colors.hairline} (top)"
    height: 52px
    geometry: "mobile home chrome (web <768px and the React Native app): four equal icon+label actions (Sessions, Board, Scheduler, Settings) above the bottom safe area. The active section paints its glyph in an accent-soft pill with an accent label; Settings is an action that opens the settings surface, never an active tab. The bar is home chrome only: an open chat hides it and the top-bar back chevron returns to the section"
  sidebar:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.text}"
    typography: "{typography.body-md}"
    padding: "{spacing.sm}"
    border: "1px solid {colors.hairline} (right)"
    width: 272px
    geometry: "272px docked at >=768px with a collapsible 60px icon rail (persisted choice); hidden below 768px (the mobile shell uses bottom-nav)"
  goal-strip:
    backgroundColor: "transparent"
    textColor: "{colors.text-muted}"
    typography: "{typography.caption}"
    padding: "4px 0"
    geometry: "one quiet line just above the composer, constrained to the chat column width: live phase, round N/M chip and Pause/Resume/Cancel side by side, never a second copy of the history"
  session-item:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    typography: "{typography.body-md}"
    rounded: "{rounded.md}"
    padding: "10px 12px"
  session-item-active:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.text}"
    indicator: "none (active is surface-muted only, no accent bar)"
  workspace-picker:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.sm}"
    padding: "6px 10px"
    border: "1px solid {colors.hairline-strong}"
  user-bubble:
    backgroundColor: "{colors.bubble-user}"
    textColor: "{colors.bubble-user-text}"
    typography: "{typography.body-md}"
    rounded: "{rounded.lg}"
    padding: "10px 14px"
    maxWidth: "85%"
  pending-bubble:
    backgroundColor: "{colors.bubble-user}"
    textColor: "{colors.bubble-user-text}"
    typography: "{typography.body-md}"
    rounded: "{rounded.lg}"
    padding: "10px 14px"
    maxWidth: "85%"
    geometry: "same geometry as user-bubble, dimmed while sending with a Sending… caption; on failure it stays visible next to Retry/Dismiss"
  assistant-block:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    typography: "{typography.body-md}"
    maxWidth: "68ch"
  agent-label:
    backgroundColor: "transparent"
    textColor: "{colors.text-muted}"
    typography: "{typography.micro}"
  session-meta:
    backgroundColor: "transparent"
    textColor: "{colors.text-muted}"
    typography: "{typography.code-sm}"
  message-stats:
    backgroundColor: "transparent"
    textColor: "{colors.text-faint}"
    typography: "{typography.code-sm}"
    geometry: "icons + numbers only ($, up/in, down/out, sparkle/reasoning, bolt/speed); labels live in tooltips; cache read/write never shown"
  session-stats:
    backgroundColor: "transparent"
    textColor: "{colors.text-muted}"
    typography: "{typography.caption}"
    geometry: "same icon + number rhythm as message-stats; on mobile it aligns left when it wraps to its own line"
  tool-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.lg}"
    padding: "0"
    border: "1px solid {colors.hairline}"
  tool-card-header:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    typography: "{typography.body-sm}"
    padding: "10px 12px"
  tool-card-error:
    border: "1px solid {colors.hairline-strong} (same neutral chrome; error reads in the status dot and title, never in a colored border)"
  code-block:
    backgroundColor: "{colors.code-surface}"
    textColor: "{colors.code-text}"
    typography: "{typography.code-md}"
    rounded: "{rounded.md}"
    padding: "12px 14px"
  code-block-header:
    backgroundColor: "{colors.code-surface}"
    textColor: "{colors.code-muted}"
    typography: "{typography.code-sm}"
    padding: "8px 14px"
    border: "1px solid {colors.code-surface-soft} (bottom)"
  diff-add:
    backgroundColor: "rgba(11, 107, 83, 0.12)"
    textColor: "{colors.success}"
    typography: "{typography.code-md}"
  diff-remove:
    backgroundColor: "rgba(179, 38, 30, 0.10)"
    textColor: "{colors.danger}"
    typography: "{typography.code-md}"
  status-dot-idle:
    backgroundColor: "{colors.hairline-strong}"
    size: 8px
  status-dot-busy:
    backgroundColor: "{colors.warning}"
    size: 8px
    motion: "pulse 1.6s ease-in-out infinite"
  status-dot-connected:
    backgroundColor: "{colors.success}"
    size: 8px
  chip-neutral:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.text-muted}"
    typography: "{typography.caption}"
    rounded: "{rounded.full}"
    padding: "3px 10px"
  chip-accent:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.text-muted}"
    typography: "{typography.caption}"
    rounded: "{rounded.full}"
    padding: "3px 10px"
  chip-warning:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.text-muted}"
    typography: "{typography.caption}"
    rounded: "{rounded.full}"
    padding: "3px 10px"
  chip-danger:
    backgroundColor: "{colors.danger-soft}"
    textColor: "{colors.danger}"
    typography: "{typography.caption}"
    rounded: "{rounded.full}"
    padding: "3px 10px"
  branch-chip:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.text-muted}"
    typography: "{typography.code-sm}"
    rounded: "{rounded.full}"
    padding: "3px 10px"
  branch-viewer:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-soft}"
    typography: "{typography.mono-sm}"
    rounded: "{rounded.md}"
    padding: "{spacing.sm} {spacing.md}"
    border: "1px solid {colors.hairline-strong}"
    geometry: "non-interactive chip: branch glyph + current branch name, no chevron, no popover, no hover/focus affordance; refreshes every 5 s and hides when the workspace is not a git repository"
  banner-warning:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.text-soft}"
    typography: "{typography.body-sm}"
    padding: "8px {spacing.md}"
    border: "1px solid {colors.hairline} (bottom, neutral; severity lives in the dot/icon only)"
  banner-danger:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.text-soft}"
    typography: "{typography.body-sm}"
    padding: "8px {spacing.md}"
    border: "1px solid {colors.hairline} (bottom, neutral; severity lives in the dot/icon only)"
  banner-info:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.text-soft}"
    typography: "{typography.body-sm}"
    padding: "8px {spacing.md}"
    border: "1px solid {colors.hairline} (bottom, neutral)"
  toast:
    backgroundColor: "{colors.text}"
    textColor: "{colors.canvas}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
    padding: "10px 14px"
    shadow: "0 8px 24px -8px rgba(12, 12, 11, 0.35)"
  empty-state:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.text-muted}"
    typography: "{typography.body-md}"
    padding: "{spacing.section-sm} {spacing.md}"
    decoration: "deco-blob + deco-dots at low opacity"
  dialog:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.body-md}"
    rounded: "{rounded.xl}"
    padding: "{spacing.lg}"
    width: "min(440px, calc(100vw - 32px))"
    shadow: "0 16px 48px -12px rgba(12, 12, 11, 0.4)"
  dialog-overlay:
    backgroundColor: "{colors.overlay}"
    backdrop: "blur(2px)"
  permission-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.lg}"
    padding: "{spacing.md}"
    border: "1px solid {colors.hairline} (neutral chrome; urgency reads in the busy dot and title)"
    placement: "inline in the transcript, in the agent block that raised it"
  permission-card-resolved:
    backgroundColor: "transparent"
    textColor: "{colors.text-muted}"
    typography: "{typography.caption}"
    rounded: "{rounded.lg}"
    padding: "{spacing.xs} 0"
  question-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.lg}"
    padding: "{spacing.md}"
    border: "1px solid {colors.hairline} (neutral chrome)"
    placement: "inline in the transcript, in the agent block that raised it"
  question-index:
    backgroundColor: "transparent"
    textColor: "{colors.text-muted}"
    typography: "{typography.caption}"
    padding: "0 2px"
    border: "2px solid transparent (bottom)"
  question-index-active:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    typography: "{typography.caption}"
    border: "2px solid {colors.text} (bottom, neutral underline)"
  option-row:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
    padding: "10px 12px"
    border: "1px solid {colors.hairline-strong}"
  option-row-selected:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.text}"
    border: "1px solid {colors.hairline-strong} (neutral; selected mark uses {colors.text})"
  choice-modal:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.xl}"
    padding: "{spacing.lg}"
    border: "1px solid {colors.hairline}"
  side-panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.lg}"
    padding: "{spacing.md}"
    border: "1px solid {colors.hairline}"
    width: "min(360px, calc(100vw - 32px))"
  login-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.xxl}"
    padding: "{spacing.xl}"
    width: "min(400px, calc(100vw - 32px))"
    border: "1px solid {colors.hairline}"
    decoration: "deco-blob behind the card, deco-dots at the base"
  goal-review:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.lg}"
    padding: "{spacing.md}"
    border: "1px solid {colors.hairline}"
    geometry: "one collapsible round row per review (Round N, verdict chip, one-line summary; latest open); bodies are critic-block (argument + issue rows with severity chip and evidence) and verdict-block (decision chip, reasoning, required changes)"
  goal-report:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "10px 12px"
    border: "1px solid {colors.hairline} (neutral card, no side rule; blocked state reads in the chip and dot)"
    geometry: "completion marker card: summary plus evidence list; critique/verdict markers reuse the same blocks"
  run-preview-tabs:
    backgroundColor: "transparent"
    textColor: "{colors.text-muted}"
    typography: "{typography.caption}"
    geometry: "one internal tablist (Run | Preview) with tab/tabpanel semantics and arrow-key navigation; opens on Preview when the tunnel runs, otherwise on Run; port chip in the shared header"
  settings-panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.body-md}"
    padding: "{spacing.lg}"
    geometry: "two-pane on desktop (220px section nav + content); master-detail on small screens (section list with >=56px rows, label + description + chevron; back control in detail)"
  settings-module-head:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    typography: "{typography.heading-3}"
    geometry: "primary action pinned above the section in normal flow (e.g. Add provider); wraps on narrow widths"
  theme-swatches:
    backgroundColor: "transparent"
    textColor: "{colors.text-soft}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
    geometry: "grid of min(88px, 1fr) option boxes with centered ellipsis labels; selected option uses a neutral {colors.hairline-strong} ring on {colors.surface-muted} (same box as palette-grid)"
  palette-grid:
    backgroundColor: "transparent"
    textColor: "{colors.text-soft}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
    geometry: "grid of min(88px, 1fr) color-theme options (paper first); canvas/accent/accent dot under the name; selected option uses a neutral {colors.hairline-strong} ring on {colors.surface-muted}"
  provider-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "10px 12px"
    border: "1px solid {colors.hairline-strong}"
    geometry: "Providers-style card: avatar, semibold name, Connected/Active chips, credential rows with confirm-before-Disconnect, secondary Connect button; Add provider pinned above the list; custom add dialog debounces /models discovery with a manual Load models fallback"
  websearch-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "10px 12px"
    border: "1px solid {colors.hairline-strong}"
    geometry: "same card rhythm as provider-card with radio semantics (Automatic + one default); Test probe shows the answering source or a mapped error"
  icon-set:
    backgroundColor: "transparent"
    textColor: "{colors.text-muted}"
    geometry: "single vector source (folder, chevrons, plus, x, check, trash, brain, sliders, arrows, sparkle, bolt, external link, shield-check, sun/moon, branch, key, gear, search, play/pause/stop); no inline one-off SVGs, no emoji glyphs"
  deco-blob:
    backgroundColor: "{colors.accent-soft}"
    opacity: 0.9
    geometry: "organic 6–8 point bezier, 240–480px"
  deco-dots:
    backgroundColor: "{colors.hairline-strong}"
    opacity: 0.7
    geometry: "1.5px dots on a 12px grid"
  deco-hatch:
    backgroundColor: "{colors.hairline}"
    opacity: 1
    geometry: "1px 45° lines every 7px"
  deco-curve:
    backgroundColor: "transparent"
    textColor: "{colors.accent}"
    geometry: "1.5px stroke, single long arc"
  focus-ring:
    backgroundColor: "transparent"
    textColor: "transparent"
    ring: "2px solid {colors.accent}, offset 2px"
---

## Overview

MasterHand is a serious tool that should still feel handmade. The visual language is **ink on paper**: near-black ink on warm paper white in light mode, chalk-white ink on charcoal in dark mode, with a single **deep-emerald** accent (`{colors.accent}`) that behaves like a fountain-pen mark — rare, deliberate, and never decorative. Everything else is typography, hairlines and whitespace, in the spirit of editorial print: a classical serif (`{typography.display-hero}`) for brand moments, a quietly characterful grotesk for the working UI, and monospace for code and machine output.

Where an interface would otherwise sit empty — login, first-run, an empty session list, a paused agent — the system allows **organic decoration**: a soft blob, a halftone dot field, a patch of line hatching, or one long curved accent line. Decoration is a courtesy, not a costume: it fills truly empty surfaces, stays out of text columns, and is removed entirely wherever content is dense (chat transcript, tool output, tables). The result should read as "a quiet desk with a few ink marks", never as a pattern catalogue.

Both themes are equal citizens. Light is the default editorial surface (warm paper, ink text); dark is the working surface for long sessions (charcoal, chalk). The token names are semantic (`{colors.canvas}`, `{colors.surface}`, `{colors.text}`, `{colors.accent}`), so a theme flip is a value swap, not a redesign.

**Key Characteristics:**
- Near-monochrome base: warm paper / charcoal canvas, ink / chalk text, hairline borders — no gradients anywhere
- Exactly ONE accent hue: deep emerald (`{colors.accent}`), budgeted to <10% of any screen (primary CTA, focus ring, status dots, links)
- Sober chrome: neutral hairline containers everywhere; no colored card borders, no tinted banner strips, no accent selection rings
- Editorial type pairing: **Fraunces** for display and the wordmark, **Instrument Sans** for all UI and body, **JetBrains Mono** for code — all swappable through three CSS variables
- Organic decoration in empty rooms only: `{components.deco-blob}`, `{components.deco-dots}`, `{components.deco-hatch}`, `{components.deco-curve}`
- Flat depth: hairlines and surface steps do the work; shadows reserved for overlays
- Mobile-first: 44px touch targets, bottom sheets for management dialogs, `bottom-nav` in the web build below 768px and in the native app — then progressively enhanced for desktop
- Blocking requests live in the flow: permission requests and agent questions render inline in the transcript (never as modals), and a multi-question form carries a tab index on top
- The chat transcript is sacred: full width of a 768px column, zero decoration behind messages
- Settings is a catalog, not a form: Appearance, Goal review, Web search and Providers share one panel rhythm (module head, cards, chips, ghost/danger actions)
- Usage is icons + numbers only: session and per-message stats share one rhythm (`{components.session-stats}`, `{components.message-stats}`), labels live in tooltips
- One vector icon set: every glyph comes from a single source (`{components.icon-set}`), never inline one-offs or emoji

## Colors

> Semantic tokens above carry the **light** values. The dark column is the authoritative override set, implemented in `design.css` under `[data-theme="dark"]`. Raw ramps (`ink-*`, `grey-*`, `emerald-*`) are shared by both themes.

### Light / Dark mapping

| Token | Light | Dark | Role |
|---|---|---|---|
| `{colors.canvas}` | `#FAFAF7` paper | `#0C0C0B` ink-950 | Page background |
| `{colors.surface}` | `#FFFFFF` | `#141413` ink-900 | Cards, fields, dialogs |
| `{colors.surface-muted}` | `#F2F2EE` grey-50 | `#1C1C1A` ink-800 | Hover, active rows, chips |
| `{colors.text}` | `#0C0C0B` ink-950 | `#F2F2ED` chalk | Primary text |
| `{colors.text-soft}` | `#4A4A46` ink-500 | `#C9C9C2` | Secondary text |
| `{colors.text-muted}` | `#6E6E6A` grey-500 | `#8E8E88` | Tertiary text, metadata |
| `{colors.text-faint}` | `#8E8E88` grey-400 | `#6A6A65` | Disabled, placeholders |
| `{colors.hairline}` | `#E8E8E2` grey-100 | `#262624` ink-700 | Dividers, card borders |
| `{colors.hairline-strong}` | `#D6D6D0` grey-200 | `#3A3A37` ink-600 | Input borders |
| `{colors.accent}` | `#0B6B53` emerald-700 | `#3ED8A8` emerald-300 | THE accent |
| `{colors.accent-strong}` | `#085041` emerald-800 | `#8BE9C9` emerald-200 | Pressed / hover |
| `{colors.accent-soft}` | `#D9EAE3` emerald-100 | `rgba(62,216,168,0.14)` | Tint: chips, blobs, focus ring |
| `{colors.on-accent}` | `#FFFFFF` | `#04140E` | Text on accent fills |
| `{colors.bubble-user}` | `#085041` emerald-800 | `#06372C` emerald-900 | User message bubble fill (deep emerald, never a bright surface) |
| `{colors.bubble-user-text}` | `#FFFFFF` | `#D9EAE3` emerald-100 | Text on the user bubble (≥ 4.5:1 in both themes) |
| `{colors.warning}` | `#8A5A00` | `#E3B341` | Busy state, banners |
| `{colors.danger}` | `#B3261E` | `#F08A82` | Destructive, errors |
| `{colors.success}` | `#0B6B53` | `#3ED8A8` | Completed, connected |
| `{colors.code-surface}` | `#141413` ink-900 | `#171716` | Code blocks (always dark) |

### Color themes

Settings > Appearance offers **13 color themes** (Paper default + Catppuccin, Dracula, Tokyo Night, Nord, Synthwave '84, Gruvbox, Rosé Pine, Everforest, Solarized, One Dark, Monokai, Ayu), each with light and dark variants. Light/dark stays an independent axis: the mode picks the column, the theme picks the row.

| Theme | Light canvas / accent | Dark canvas / accent | Role |
|---|---|---|---|
| Paper (default) | `#FAFAF7` / `#0B6B53` | `#0C0C0B` / `#3ED8A8` | The ink-on-paper theme |
| Catppuccin | `#EFF1F5` / `#8839EF` | `#1E1E2E` / `#CBA6F7` | Latte / Mocha |
| Dracula | `#F8F8F2` / `#7B3FD4` | `#282A36` / `#BD93F9` |  |
| Tokyo Night | `#E1E2E7` / `#1B5FC1` | `#1A1B26` / `#7AA2F7` | Day / Night |
| Nord | `#ECEFF4` / `#3A6592` | `#2E3440` / `#88C0D0` | Snow Storm / Polar Night |
| Synthwave '84 | `#F7ECF5` / `#A81A8B` | `#2B213A` / `#FF7EDB` |  |
| Gruvbox | `#FBF1C7` / `#AF3A03` | `#282828` / `#FE8019` | Light / Dark |
| Rosé Pine | `#FAF4ED` / `#B4637A` | `#232136` / `#EBBCBA` | Dawn / Moon |
| Everforest | `#FDF6E3` / `#5F7E00` | `#2D353B` / `#A7C080` | Light / Dark |
| Solarized | `#FDF6E3` / `#1A6DA5` | `#002B36` / `#2AA198` | Light / Dark |
| One Dark | `#FAFAFA` / `#026795` | `#282C34` / `#61AFEF` | One Light / One Dark |
| Monokai | `#F9F8F0` / `#A8124A` | `#272822` / `#FF6188` |  |
| Ayu | `#FAFAFA` / `#C24A1F` | `#0F1419` / `#FFB454` | Light / Dark |

A theme repaints the full surface/text/hairline/code/syntax set plus the accent family and a matching `surface-muted`/`blob`/`selection` tint. Only color tokens change — layout, spacing and radii stay identical across themes. The semantic warning/danger/success tokens stay shared. Light accents are dark shades (readable on paper), dark accents are light shades (readable on charcoal); unknown stored values (including the legacy accent-color ids) fall back to paper. Palette ids are URL-safe slugs (`paper`, `rose-pine`, `synthwave-84`, `tokyo-night`, `one-dark`); the Light/Dark picker and the color-theme picker share the same grid and selected ring (`{components.theme-swatches}`, `{components.palette-grid}`).

### Syntax tokens

Tool cards and fenced message code highlight by language with one shared token palette, tuned for the dark code surface in both themes:

| Token | Color | Use |
|---|---|---|
| keyword | `#C792EA` | `const`, `def`, `if`, … |
| string | `#9ECE8A` | quoted text |
| number | `#E3B341` | numeric literals |
| comment | `#7A7A76` italic | `//`, `#`, `/* … */` |
| function | palette dark accent | call names (`fetch(`) |
| type | `#7DD3FC` | `Capitalized` names |

Function names follow the active palette (the dark accent reads on dark code in every theme); the rest is fixed. Diff add/remove rows keep their semantic row colors — only context lines highlight. Unknown languages render plain, never broken. Each color theme ships its own syntax hues for the same six tokens; the preview gallery shows the Paper set.

### Brand & Accent
- **Deep Emerald** (`{colors.accent}`): the single accent. Primary buttons, focus rings, links, status dots.
- **Emerald Strong** (`{colors.accent-strong}`): pressed states and hover on dark.
- **Emerald Soft** (`{colors.accent-soft}`): 10–15% tint surfaces — blobs and focus glow. Never used as a large page background, card border or banner fill.

### Neutral warm (light) / charred (dark)
- **Paper** (`{colors.paper}`): warm off-white canvas; pure white is reserved for elevated surfaces so they read as "sheets on a desk".
- **Ink 950…500** (`{colors.ink-950}` … `{colors.ink-500}`): the black ramp; also the source of the alt theme backgrounds.
- **Grey 500…50** (`{colors.grey-500}` … `{colors.grey-50}`): secondary text and dividers.

### Semantic
- **Warning**, **Danger**, **Success** are desaturated to sit inside the editorial palette; they never compete with the accent for attention. Busy dots use warning; `button-danger`, `chip-danger` and error dots use danger. Banners and cards stay neutral — severity reads in the dot/icon, not the chrome.

### Color rules
- Accent budget: if removing every emerald pixel would break comprehension, there is too much of it.
- Sober chrome: card and strip containers never use colored borders. All cards use `{colors.hairline}` (or `{colors.hairline-strong}` for selected); severity and state read in dots, icons and text only.
- Banners are a single neutral strip; `chip-accent`, `chip-warning` and `branch-chip` are neutral pills. Only `button-danger` and `chip-danger` keep semantic red, plus status dots.
- No gradients, no second hue. The only permitted color besides the ramps is a translucent tint of emerald or of a semantic color (focus ring, diff rows, code syntax, decoration blobs).
- Code surfaces stay dark in both themes (`{colors.code-surface}`): a held-over blackboard that matches the blob decoration language.

## Typography

### Font Family
**Fraunces** (display): a variable old-style serif with optical size and "wonk" axes. Used for the wordmark, hero displays, section openers and empty-state headlines. Fallbacks: Georgia, 'Times New Roman', serif.

**Instrument Sans** (UI + body): a contemporary grotesk with better personality than Inter and excellent small-size legibility; carries all interface text, labels, buttons and long-form body. Fallbacks: system-ui, -apple-system, 'Segoe UI', sans-serif.

**JetBrains Mono** (code): commands, diffs, tokens, session metadata. Fallbacks: 'SF Mono', Menlo, Consolas, monospace.

Fonts are intentionally easy to replace: the whole system references three CSS custom properties — `--font-display`, `--font-ui`, `--font-mono`. Swapping a family means editing those variables (and the Google Fonts `<link>`), nothing else.

### Hierarchy

| Token | Size | Weight | Line Height | Letter Spacing | Family | Use |
|---|---|---|---|---|---|---|
| `{typography.display-hero}` | 56px | 400 | 1.05 | -0.02em | Fraunces | Hero headlines, login wordmark block |
| `{typography.display-lg}` | 42px | 400 | 1.08 | -0.02em | Fraunces | Section openers |
| `{typography.heading-1}` | 32px | 400 | 1.15 | -0.01em | Fraunces | Page titles, dialog titles |
| `{typography.heading-2}` | 26px | 500 | 1.2 | -0.01em | Fraunces | Empty-state headlines, group titles |
| `{typography.heading-3}` | 20px | 600 | 1.3 | 0 | Instrument Sans | Card / panel titles |
| `{typography.heading-4}` | 17px | 600 | 1.35 | 0 | Instrument Sans | Session titles, small heads |
| `{typography.body-lg}` | 17px | 400 | 1.6 | 0 | Instrument Sans | Lead paragraphs |
| `{typography.body-md}` | 15px | 400 | 1.6 | 0 | Instrument Sans | Default body and chat text |
| `{typography.body-md-medium}` | 15px | 500 | 1.6 | 0 | Instrument Sans | Emphasis, top bar title |
| `{typography.body-sm}` | 13px | 400 | 1.5 | 0 | Instrument Sans | Secondary UI, tool card body |
| `{typography.caption}` | 12px | 400 | 1.45 | 0 | Instrument Sans | Metadata, chips, timestamps |
| `{typography.micro}` | 11px | 600 | 1.4 | 0.08em | Instrument Sans | Uppercase eyebrows, agent labels |
| `{typography.button}` | 14px | 500 | 1.2 | 0 | Instrument Sans | Button labels |
| `{typography.wordmark}` | 20px | 600 | 1.2 | -0.01em | Fraunces | Top-bar wordmark |
| `{typography.code-md}` | 13px | 400 | 1.6 | 0 | JetBrains Mono | Code blocks, diffs |
| `{typography.code-sm}` | 12px | 400 | 1.5 | 0 | JetBrains Mono | Inline code, metadata, branches |

### Principles
- **Serif speaks, sans works.** Fraunces appears only at moments that carry brand voice (hero, login, empty states, dialog titles). All functional UI is Instrument Sans.
- **Serif never below 26px.** Fraunces loses its authority at small sizes; small text is always sans or mono.
- **Chat is set for reading:** `{typography.body-md}` at 1.6 leading, maximum 68ch per assistant block, with generous paragraph spacing.
- **Mobile-first sizes:** the table lists desktop maxima; on screens < 768px, display sizes step down (56→40, 42→32, 32→26) while body sizes stay fixed for comfort.

## Layout

### Spacing System
- **Base unit**: 4px; primary increment 8px.
- **Tokens**: `{spacing.xxs}` (4) · `{spacing.xs}` (8) · `{spacing.sm}` (12) · `{spacing.md}` (16) · `{spacing.lg}` (20) · `{spacing.xl}` (24) · `{spacing.xxl}` (32) · `{spacing.xxxl}` (40) · `{spacing.section-sm}` (48) · `{spacing.section}` (64) · `{spacing.section-lg}` (96) · `{spacing.hero}` (112)
- **Chat rhythm**: 16px between message groups, 8px inside a group; tool cards indent 0 on mobile, 12px under the agent label on desktop.
- **Marketing / preview pages**: `{spacing.section}` between sections, `{spacing.section-lg}` around the hero.

### Grid & Container
- **Chat column**: 768px max, centered, 16px gutters on mobile — the product's most important measurement.
- **Sidebar**: 272px, collapses to a 60px icon rail on desktop (persisted choice; full list and footer hide). Below 768px the sidebar is hidden and `bottom-nav` takes over.
- **Docs / preview container**: 1200px max, 24px gutters.
- **Management dialogs** (workspace add/remove, choice modal): 440px max, become bottom sheets below 640px.
- **Blocking cards** (permission, questions): never dialogs; they live in the 768px chat column at every size.
- **Side panels** (side question, run & preview, audit): 360px, become full-width sheets on mobile.

### Whitespace Philosophy
Dense where the work is, airy where the work waits. Transcripts, diffs and tool output pack tightly with hairline separation. Empty states, login and session lists breathe, and that breathing room is exactly where decoration is allowed to live. Never both at once: decoration and density are mutually exclusive per surface.

## Elevation & Depth

Depth is drawn with lines, not shadows. Two adjacent hairlines and one surface step read as a layer; a shadow would make the interface feel like a consumer dashboard.

| Level | Treatment | Use |
|---|---|---|
| 0 (flat) | `1px {colors.hairline}` border, no shadow | Default cards, tool cards, panels, inputs |
| 1 (hover) | Surface steps to `{colors.surface-muted}` | Session rows, chips, ghost buttons |
| 2 (raised) | `1px {colors.hairline}` + `0 1px 2px rgba(12,12,11,0.05)` | Selected tool card, toast resting |
| 3 (overlay) | `0 16px 48px -12px rgba(12,12,11,0.40)` + `{colors.overlay}` scrim | Dialogs, bottom sheets, command popovers |

### Decorative Depth
- The blob (`{components.deco-blob}`) is the only element allowed to carry a soft edge; it sits behind content at low saturation and never overlaps text.
- In dark theme, elevation is expressed by lightening surfaces (`canvas → surface → surface-muted`) rather than shadowing; shadows are nearly invisible and reserved for overlays.

## Shapes

### Border Radius Scale

| Token | Value | Use |
|---|---|---|
| `{rounded.xs}` | 6px | Inline code, tiny controls |
| `{rounded.sm}` | 8px | Icon buttons, selects, inline chips |
| `{rounded.md}` | 12px | Buttons, inputs, code blocks, toasts |
| `{rounded.lg}` | 16px | Cards, tool cards, question cards, user bubbles |
| `{rounded.xl}` | 20px | Dialogs, login card inner |
| `{rounded.xxl}` | 24px | Login card, phone-frame surfaces |
| `{rounded.full}` | 9999px | Filter pills, status chips, branch chips |

The scale is soft but not playful: controls and cards use the same 12–16px family, pills are reserved for filters and status. The phone frame in the preview and the login card use the largest radii because they are "objects on a desk".

### Decoration Geometry
- **Blob**: closed bezier of 6–8 anchor points with 1.6–2.0 control-point tension, 240–480px, slightly off-screen allowed. Never a perfect circle.
- **Dots**: 1.5px radius dots on a 12px grid, clipped to a rectangle or blob, 70% opacity — halftone, not a texture wallpaper.
- **Hatch**: 1px lines at 45°, 7px pitch, hairline color; used in strips no taller than 96px.
- **Curve**: a single 1.5px stroke arc or S-curve, accent or ink color, spanning 120–320px. One per composition, never two.
- Decoration is `aria-hidden`, `pointer-events: none`, and removed under `prefers-reduced-transparency` fallbacks if ever animated.

## Components

> Per the no-hover policy, only default, pressed/active and disabled states are documented. Hover is a surface step to `{colors.surface-muted}`.

### Actions

**`button-primary`** — the only filled emerald control.
- Background `{colors.accent}`, text `{colors.on-accent}`, typography `{typography.button}`, rounded `{rounded.md}`, height 44px, padding `10px 18px`.
- Pressed: `button-primary-pressed` deepens to `{colors.accent-strong}`. Disabled: `button-primary-disabled` uses `{colors.surface-muted}` + `{colors.text-faint}`.
- Focus: `{components.focus-ring}` — 2px accent ring at 2px offset. On dark, `{colors.accent}` is emerald-300 and `{colors.on-accent}` is near-black.

**`button-secondary`** — outlined companion.
- Transparent background, `{colors.text}` text, `1px solid {colors.hairline-strong}` border, same geometry as primary.

**`button-ghost`** — quiet tertiary action (Back, Disconnect, panel triggers).
- Transparent, `{colors.text-muted}` text, `{rounded.sm}`, compact padding.

**`button-danger`** — destructive (Reject, Delete, Remove).
- `{colors.danger-soft}` background, `{colors.danger}` text, `{colors.danger-line}` border. Never filled solid red.

**`button-icon`** — square 40×40 (44×44 on touch), glyph or SVG at 18–20px, `{colors.text-muted}`.

### Forms

**`text-field`** — default input, 44px height, `{colors.surface-muted}` background with a transparent 1px border and `{rounded.sm}`. It reads as one quiet surface step, not a boxed control. **`text-field-focused`** switches the border to `{colors.text-muted}` and adds a faint 12%-opacity neutral ring — the accent never floods a field. The caret is the only accent. **`text-area`** uses `{rounded.md}` for multi-line input (prompts, descriptions), grows with its content and disables the native resize grip (Chromium paints it light regardless of `color-scheme`, so it showed as a white corner on dark); fields used for titles grow into paragraphs instead of clipping. **`select-trigger`** is the compact dropdown (agent, model, effort); the effort trigger carries a brain glyph for reasoning-effort variants and a generic sliders glyph otherwise, and the model trigger carries the provider brand mark (ADR-28, monogram fallback) plus the short model name — the full `Provider · Model` label stays in the list rows and the tooltip. Inside the composer dock the three triggers render borderless (ghost pills) while menus elsewhere keep the bordered trigger. **`search-field`** is a `{rounded.lg}` input with a leading glyph (session filter, model search). **`composer-bar`** is a single dock card on `{colors.surface}` (`{rounded.lg}`, level-1 shadow, deliberately no focus ring): a context bar above the input — the workspace menu, read-only branch viewer and stats behind a bottom hairline — a borderless message field, and the context selectors (agent, model, effort as ghost pills, auto-accept, Send/Stop with icons) integrated in the toolbar below it. The Goal Mode control line renders just above the composer, constrained to the chat column width.

**`attachment-chip`** — staged files sit in a wrapping strip above the message field and in the user bubble after sending. One chip is a `{colors.surface-muted}` row (`{rounded.md}`, hairline border): a 36px square thumbnail (images) or a 36px glyph tile (others; history uses 64px), the name truncated to one line at 12px/500, the size or error at 11px/`{colors.text-muted}`, and a 24px remove/download icon button. Uploading swaps the trailing icon for a 14px spinner; an error switches the border to `{colors.danger-line}` and the background to `{colors.danger-soft}`. Inside the dark user bubble the chip uses a translucent white surface and `{colors.bubble-user-text}`. The paperclip lives at the start of the composer toolbar as a ghost `button-icon` (30px, 44px touch target). While a file is dragged over the chat column, a `dropzone` overlay covers the column with a 2px dashed `{colors.accent}` border, canvas wash, accent text and a paperclip glyph; it is `pointer-events: none` and never intercepts the drop.

### Navigation

**`top-bar`** — 56px, canvas background, bottom hairline. Mobile: back chevron when a chat is open, truncated section/session title, status dot, overflow menu. Desktop: title, connection state, sessions count.

**`sidebar`** — 272px canvas column, right hairline, desktop only (≥768px). Contains the session list and the new-session `+` action (which creates immediately); workspace switching lives in the composer bar. It collapses to a 60px icon rail (`{components.sidebar}` geometry): the rail keeps the collapse toggle, the new-session action and navigation glyphs. Below 768px the web build drops the sidebar entirely and navigates through `bottom-nav` (the session list is the Sessions screen, with the workspace picker above it); the React Native app does the same.

**`bottom-nav`** — mobile primary navigation (web <768px and the React Native app), pinned above the bottom safe area: one canvas bar with a top `{colors.hairline}`, four equal actions (Sessions, Board, Scheduler, Settings) at ≥44px. Each action is a 20px glyph over a `{typography.caption}` label; the active section paints the glyph in an `{colors.accent-soft}` pill with an `{colors.accent}` label, inactive actions use `{colors.text-muted}`. Sessions opens the list (or the already-open chat), Board the kanban and Scheduler the task manager; Settings is an action (it opens the settings surface, where Disconnect lives on mobile), not a section. The bar is home chrome only: an open chat takes over the screen, hides it, and the `top-bar` back chevron returns to the section the chat was opened from.

**`session-item`** — full-width row, `{rounded.md}`, title in `{typography.heading-4}`, meta line in `{typography.session-meta}` (directory · relative time). **`session-item-active`** steps the surface to `{colors.surface-muted}` with no accent bar — the row weight does the work.

**`workspace-picker`** — compact menu in the composer bar: shows the current workspace and, on click, the workspace list plus the add/remove management actions.

**`branch-viewer`** — non-interactive chip next to the workspace menu: branch glyph + the current branch name, no chevron and no popover. The clients poll it every 5 s so an agent-side switch appears on its own; it hides when the workspace is not a git repository.

### Conversation

**`user-bubble`** — right-aligned, deep-emerald fill: `{colors.bubble-user}` background, `{colors.bubble-user-text}` text, `{rounded.lg}`, max 85% width. It is the only filled transcript surface, so it uses the accent ramp **darker** (emerald-800 light / emerald-900 dark) instead of the inverted ink pair, which made every user message the brightest element on a dark canvas.

**`assistant-block`** — no bubble. Agent label in `{typography.micro}` uppercase + `{colors.text-muted}`, body in `{typography.body-md}`, max 68ch. Code, tool cards and blocking-request cards stack inside the block at full column width.

**`pending-bubble`** — the ghost of a plain prompt awaiting delivery confirmation: same geometry as `{components.user-bubble}`, dimmed, with a `Sending…` caption (busy dot). On a hard failure it stays visible next to Retry (`button-secondary`) and Dismiss (`button-ghost`); the real bubble replaces it the moment the send marker lands in the history.

**`message-stats`** — per-message usage under the assistant block: model id, cost and the icon + number rhythm (`$`, up/in, down/out, sparkle/reasoning, bolt/speed) with labels only in tooltips and `aria-label`s. Cache read/write are never shown. Nothing renders until the message completes.

**`agent-label`** / **`session-meta`** — micro-label and mono metadata as described in Typography.

**`permission-card`** — a permission request renders **inline in the transcript**, inside the agent block that raised it: `{colors.surface}`, `{colors.hairline}` border, `{rounded.lg}`. Header = busy dot + "Permission requested"; body = one-line context + the command in a `code-block`; actions = Allow once (`button-primary`), Always allow (`button-secondary`), Reject (`button-danger`). Once answered it collapses to `permission-card-resolved`: a quiet caption row (state dot + "Allowed once · 2m ago") that stays in the flow as history. It is never a modal — the request belongs to the agent turn that asked for it.

**`question-card`** — an agent question renders **inline in the transcript**, same placement rules: `{colors.surface}`, `{colors.hairline}` border, `{rounded.lg}`. A single question shows the prompt plus `option-row`s; a **multi-question form shows a top index** (`question-index` tabs — one per question plus a final Submit step) so the user can jump straight to any question, with the active tab underlined in `{colors.text}` and an error dot on questions that fail validation. The footer is Next/Submit (`button-primary`) plus Dismiss (`button-ghost`).

**`goal-strip`** — Goal Mode's control line renders just above the composer, outside the dock and the transcript and no wider than the chat column: live phase, `round N/M` chip and Pause/Resume/Cancel side by side, plus an inline error row when the run fails. No dropdown, no result text on the side — history lives in the thread (`{components.goal-review}`). Returns null when the session has no run.

**`goal-review`** — Goal Mode's critic/judge work renders **inline in the transcript** (their internal sessions never list in the sidebar): a `{colors.surface}` section with `{rounded.lg}` holds one collapsible round row per review (`Round N`, verdict chip, one-line summary; the latest round open, older ones expand on demand). Bodies are a `critic-block` (argument plus issue rows with a severity chip and evidence) and a `verdict-block` (decision chip, reasoning and the required changes). A completion marker in an assistant message becomes a `goal-report` card (neutral `{colors.hairline}` card, no side rule), the summary and an evidence list; critique/verdict markers found in a message reuse the same blocks inside a `tool-card`-style shell. Open-critic/open-judge links ride the review cards so both sessions open like a subagent child.

**`board`** — one kanban per workspace, following the selected workspace (no board selector beyond the existing `workspace-picker`). The main view is a horizontal scroll of `board-column`s (`{colors.canvas}` column, `{rounded.lg}`, 288px, header = inline-rename title + card-count chip + options menu with Move left/right and Delete). Cards are `{colors.surface}` rows (`{rounded.md}`, title + two-line description, click opens the edit dialog); empty columns show a dashed drop hint. An `add-column` dashed card closes the scroll (input + icon-only "+" button, same 44px height so the row stays aligned); each column ends with an inline add-card composer. The sidebar panel lists the same columns with card counts. The empty board is an `empty-state` with an intentional asymmetric composition (no corner framing): a small soft blob centered behind the heading, a short hatch strip as an accent behind the title, and a small curve tucked under the composer's right side (the title, body and composer render above the decor: relative + z-1 inside the wrapper's stacking context, since positioned z-0 decor would otherwise paint over static text) — input + icon-only "+" button at input height (the empty-state button margin is reset so the row stays aligned). Drag uses the same neutral chrome (dragged card at 50% opacity); column reorder stays in menus in v1. On mobile, cards drag within **and across** columns: the source card stays in place at 35% opacity while a lifted copy follows the finger in a board-level preview (so it paints above adjacent columns), and holding the finger within 44px of either viewport edge auto-scrolls the board to reach off-screen columns. The commit is still one absolute `(columnID, position)`; "Move to…" and Move up/down stay available as non-gesture alternatives.

### Tools

**`tool-card`** — the agent's work unit: `{colors.surface}`, `{colors.hairline}` border, `{rounded.lg}`, collapsed to a 40px `tool-card-header` (glyph, title, status, chevron) and expanded to raw output. Status is a dot (`{components.status-dot-*}`), never a colored card. **`tool-card-error`** keeps the same neutral chrome with a slightly stronger `{colors.hairline-strong}` border; the error reads in the danger status dot and title.

**`code-block`** — dark `{colors.code-surface}` in both themes, `{rounded.md}`, `{typography.code-md}`, optional `code-block-header` with the language or command path. **`diff-add`** / **`diff-remove`** render as emerald/danger tinted rows with mono gutters.

### Status & Chips

**`status-dot-idle`** (`{colors.hairline-strong}`), **`status-dot-busy`** (warning, pulsing), **`status-dot-connected`** (success). Dots are 8px, always paired with a text label in tooltips or captions.

**`status-indicator`** — the server-oriented vocabulary approved in `animated-stats-proposal.html` and shipped in `design.css`/`styles.css`/native: **available** (`mh-status--connected`, static success check), **saved** (`mh-status--idle`, hairline-strong idle ring), **expired** (`mh-status--expired`, warning ring) and **connecting** (`mh-status--connecting`/`--busy`, 14px monochrome arc: `text-soft` on `hairline-strong`, 1s linear rotation). Only the connecting arc animates; `prefers-reduced-motion` leaves it static; status text always accompanies the glyph, and the accent is never used for the busy arc. Severity lives in the ring ink, never in row borders.

**`chip-neutral`**, **`chip-accent`**, **`chip-warning`**, **`chip-danger`**, **`branch-chip`** — pill badges at 3px/10px padding in `{typography.caption}`; branch chips use `{typography.code-sm}`. Sober chrome: `chip-accent`, `chip-warning` and `branch-chip` are neutral (`{colors.surface-muted}` + `{colors.text-muted}`); only `chip-danger` keeps its semantic tint for real errors.

**`session-stats`** — per-session usage in the composer head: cost plus the same icon + number rhythm as `{components.message-stats}` (labels in tooltips only, cache excluded). It aligns left when it wraps to its own line on narrow widths.

### Feedback

**`banner-warning`** / **`banner-danger`** / **`banner-info`** — one neutral full-width strip under the top bar: `{colors.surface-muted}` background, `{colors.hairline}` bottom border, `{colors.text-soft}` text. Severity lives in the leading dot/icon only, never in the strip chrome. They are dismissible by tap and never modal.

**`toast`** — inverted ink pill for confirmations ("Copied", "Session deleted"), `{rounded.md}`, overlay shadow, auto-dismiss.

**`empty-state`** — the decoration showcase: a `{components.deco-blob}` plus `{components.deco-dots}` at low opacity behind a `{typography.heading-2}` line, one `{typography.body-md}` sentence and at most one button. Used for: no sessions, no workspace, no messages yet, empty panel.

### Overlays

**`dialog`** — `{components.dialog-overlay}` scrim + surface card, `{rounded.xl}`, max 440px, with a quiet X in the top-right corner as the only dismiss control. Reserved for **management flows the agent cannot raise**: add/remove workspace, plus the `choice-modal`. Editor dialogs commit with a soft accent-tinted icon action (check) and resolve discard with the corner X; a destructive editor keeps a danger-tinted trash icon on the left. Irreversible confirmations keep their verb in text (Delete/Remove) — an icon alone is too ambiguous for something that cannot be undone — and still get the corner X. On mobile it is a bottom sheet with 44px actions. Blocking agent requests (permission, questions) are never dialogs — they render inline in the transcript.

**`choice-modal`** — a question raised by a session that is **not the one on screen** still needs an answer, or its agent stays blocked invisibly: the same content as `question-card`, presented as a modal with an "open session" action. Once that session is opened, the question lives inline in its transcript.

**`side-panel`** — right sheet (360px) for side questions, **Run & preview** and audit; full-width on mobile. The Run & preview panel keeps one internal tablist (`{components.run-preview-tabs}`: `Run | Preview` with `tab`/`tabpanel` semantics, arrow-key navigation, active tab underlined in `{colors.text}`) because both views drive the same dev-server lifecycle: opening it lands on Preview when the tunnel is running, otherwise on Run, and starting/stopping never forces a tab switch. A port chip sits in the shared header.

**`settings-panel`** — the gear opens one panel for Servers, Appearance, Goal review, Web search and Providers (`{components.settings-panel}`): two-pane on desktop (220px section nav + content), master-detail on small screens (section list with label + description + chevron at ≥56px rows; back control returns to the list). Every module shares the same rhythm: `{components.settings-module-head}` with the primary action pinned above the section, group labels, loading/error/notice states, and ghost text buttons for tertiaries. Servers owns the profile list (rename, disconnect keeping the profile, remove with best-effort token revocation, add). Appearance owns the mode picker (Light/Dark) plus the shared theme/palette grids (`{components.theme-swatches}`, `{components.palette-grid}`).

**`provider-card`** / **`websearch-card`** — Settings > Providers and Settings > Web search mirror each other (`{components.provider-card}`, `{components.websearch-card}`): avatar, semibold name, `Connected`/`Default`/`No API key required` chips, credential rows with confirm-before-Disconnect and a secondary Connect button. Web search keeps radio semantics (Automatic plus one default source) with the selected card on a neutral `{colors.hairline-strong}` ring; its Test probe shows the answering source or a mapped error. Custom OpenAI-compatible providers add name + auto-slugged id + base URL + key + models with an Advanced section (transport, headers, per-model limits); the model list loads from the provider's `/models` with a debounced fetch plus a manual Load button, and Create stays disabled until it loads.

**`icon-set`** — every UI glyph comes from one vector source (`{components.icon-set}`): folder, chevrons, plus, x, check, trash, brain (effort variants) / sliders, arrows, sparkle, bolt, external link, shield-check, sun/moon, branch, key, gear, search, play/pause/stop, server, globe, pencil, eye/eye-off. No inline one-off SVGs, no emoji glyphs, no font-dependent symbols in tool headers.

**`servers-screen`** — first run / server shelf replacing the password-only login (`{components.servers-screen}`). Desktop is a two-column composition: brand + display line + lede on the left, a `{rounded.xxl}` surface sheet on the right (max 400px). Mobile hides the intro and keeps the sheet full-width. First run = URL (current origin prefilled) + optional name + password; the saved state = the server list plus a dashed add row. The connecting state is a centered monogram card with a 1s monochrome arc and Cancel; the error state keeps the form inline with `role="alert"` copy.

**`server-item`** — 56px row, 2px gap between rows, `{rounded.md}`, 36px monogram (Instrument Sans 12/600, 0.06em), label + mono host, status glyph + text at the right. Active = `{colors.surface-muted}` + `{colors.hairline}` border and an accent-soft monogram; never a colored row bar. **`server-add`** is a 52px dashed `hairline-strong` row with a 28px plus tile and no fill.

**`server-switcher`** — in-app switcher: a 44px footer chip on the desktop sidebar (monogram + label + host; icon-only in the 60px rail) opening a 300px popover at level-3 elevation with the list + Add/Manage; on mobile web the top-bar monogram opens a bottom sheet (20px top radius, 44px targets). Native mirrors it with a 44px header chip and a safe-area bottom sheet.

**`server-form`** — URL + optional name + password, 44px fields, leading globe/key glyph, password reveal inside the trailing 44px target. Validation happens before submit (https except loopback, no credentials/query/hash/path, duplicate by canonical URL); errors stay inline and the draft URL/name survive a rejected password.

## Do's and Don'ts

### Do
- Keep the accent budget under ~10% of any screen: primary CTA, active indicator, focus ring, small chip
- Let hairlines and one surface step do all the layering; shadows only for overlays
- Use Fraunces for display moments only, at 26px and above
- Reserve decoration (blob, dots, hatch, curve) for genuinely empty surfaces: login, empty states, first-run, hero
- Keep the chat column at 768px with 68ch assistant text — set transcripts for reading
- Keep blocking requests in the flow: permission requests and agent questions render inline in the transcript, inside the agent turn that raised them
- Give multi-question forms a top index of tabs (one per question + Submit) so any question is one tap away
- Design at 360–430px first; every component must be usable with one thumb and 44px targets
- Test both themes on every component; dark is not an afterthought
- Keep the three font variables as the only place typefaces are named
- Keep usage stats as icons + numbers with tooltip labels; never show cache read/write
- Reuse the icon set before drawing a glyph; reuse `chip-*` before a new badge; reuse `button-secondary` before inventing a variant
- On native, use the square app radii (pickers/chips 8, actions 12) instead of pills
- Make editor dialogs icon-first: a soft accent-tinted check to commit, a danger-tinted trash to delete, and the corner X to dismiss; every icon action keeps an `aria-label`/`title` (web) or `accessibilityLabel` (native)
- Let a title field grow across several lines instead of clipping a long card title

### Don't
- Don't introduce a second accent hue, gradients, or colored glows
- Don't use `{colors.accent}` (or `{colors.accent-soft}`) as an input focus border/glow: focus is a neutral `{colors.text-muted}` border plus a faint neutral ring, and the caret is the only accent
- Don't rely on the native textarea resize grip: Chromium paints it light even with `color-scheme: dark`, so it shows as a white corner on dark; fields grow with their content instead
- Don't use a filled high-chroma primary block for a dialog's commit action — a soft accent tint is enough signal
- Don't put "Cancel"/"Save" text buttons in editor dialogs — the corner X and the check icon replace them
- Don't use colored borders on cards, banners, options or selection grids — hairlines do that job; color lives in dots, icons and text
- Don't use emerald as a large background fill or flood a screen with it
- Don't place blobs, dots or hatching behind text, diffs, code or tool output
- Don't use serif for body copy, buttons, labels or anything below 26px
- Don't stack multiple decorations: one blob OR one dot field OR one hatch strip per composition, plus at most one thin curve
- Don't use pill radii for cards, inputs or buttons — pills are only filters, chips and dots
- Don't animate decoration; only functional pulses (busy dot) and 150–200ms state transitions
- Don't invent a separate mobile look: same tokens, same components, adaptive layout
- Don't turn a permission request or an agent question into a modal or bottom sheet — only a question raised in a *different* session uses `choice-modal`
- Don't use emoji or font-dependent symbols as UI glyphs — every icon comes from the shared set
- Don't show cache token counts in session or message stats

## Locked decisions

User decisions, recorded so they are not reverted by a later redesign:

1. **Quiet inputs (2026-11-01)** — the accent border + 3px accent-soft halo on focus was judged too noisy and bright, especially on dark. Fields are one `{colors.surface-muted}` surface step with a transparent border; focus is a neutral `{colors.text-muted}` border with a faint neutral ring. No accent on field chrome.
2. **No white resize corner (2026-11-01)** — the native textarea resize grip does not follow the dark theme and looked like a broken control. Textareas set `resize: none` and grow with their content; the title field in the board card editor accepts several lines.
3. **Icon-first editor dialogs (2026-11-01)** — Save/Delete text buttons in dialogs are replaced by a soft accent-tinted check and a danger-tinted trash icon; Cancel is the X in the top-right corner. This applies on web and native, to every dialog that edits content.
4. **Destructive confirmations stay verbal (2026-11-01)** — dialogs that confirm an irreversible delete keep the verb in text (`Delete`, `Remove`, `Delete column and N cards`). The corner X still dismisses them. Icons alone are not a safe confirmation.

## Responsive Behavior

### Breakpoints
| Name | Width | Key Changes |
|---|---|---|
| Mobile | < 640px | Single column. Sidebar hidden; navigation lives in `bottom-nav` (web and native). Management dialogs and side panels become bottom sheets; permission and question cards stay inline. Display hero 40px, display-lg 32px, heading-1 26px. Decoration reduced to one element per screen. |
| Large mobile | 640–767px | Message column takes full width with 24px gutters; submission rows gain secondary actions. `bottom-nav` still drives navigation until 768px. |
| Tablet | 768–1023px | Sidebar docks at 272px. Two-column form rows. Chat column centers with 32px gutters. Top-bar secondary info appears. |
| Desktop | 1024–1279px | Preview/docs grid 3-up. Panels dock to the right at 360px. Full decoration composition on hero/login/empty states. |
| Wide | ≥ 1280px | 1200px container, display tokens at full size. |

### Touch Targets
- All buttons and rows render at ≥44px effective height on touch (`button-icon` grows 40→44px)
- Filter pills grow from 32px to 44px on mobile
- Bottom sheets keep their primary action within the lower third of the screen

### Collapsing Strategy
- **Sidebar**: desktop only (≥768px), collapsing to a 60px icon rail (persisted); the rail keeps the toggle, new-session and navigation actions. Below 768px the web build and the React Native app replace it with `bottom-nav` (home sections + Settings); the session list becomes the Sessions screen and Settings hosts Disconnect.
- **Settings**: two-pane on desktop; on small screens a master-detail list (label + description + chevron, ≥56px rows) shows one section at a time with a back control, with Disconnect at the end of the list.
- **Chat**: same DOM — the transcript is single-column on all sizes; only gutters and the side-panel dock change
- **Tool cards**: collapse to header row on mobile; expanded output scrolls horizontally rather than wrapping code
- **Question index**: tabs scroll horizontally when they overflow (never wrap to a second row); the active question stays visible
- **Management dialogs** (workspace add/remove, choice modal): bottom sheets below 640px, centered cards above
- **Panels** (side question / run & preview / audit): full-width sheet on mobile, 360px dock on desktop
- **Frames in the preview page**: phone and browser frames stack vertically below 1024px; the mock app inside the browser frame responds to **container width**, not viewport

### Decoration Behavior
- Mobile: at most one decoration element per screen, at reduced size (blob ≤240px)
- Tablet: two elements (blob + dots)
- Desktop: full composition (blob + dots + one hatch or curve)
- Disabled entirely behind any dense content, at any breakpoint

## Iteration Guide

1. Focus on ONE component at a time; reference tokens directly (`{colors.accent}`, `{components.tool-card}`, `{components.status-dot-busy}`).
2. Validate the file with `npx @google/design.md lint DESIGN.md` after edits.
3. Default to `{typography.body-md}` for chat and UI, `{typography.heading-3}` for card titles, `{typography.display-*}` only for brand moments.
4. New colors are not allowed unless they are a step on an existing ramp and documented in the Colors mapping table.
5. New components: add a `components:` entry AND a prose block AND a gallery item in `DESIGN.html`.
6. Check every change in light and dark before calling it done.
7. Respect the YAGNI ladder: reuse `button-secondary` before inventing a variant; reuse `chip-*` before a new badge.
8. When in doubt, remove a decoration and add whitespace instead.

## Known Gaps

- Tool glyphs come from the shared vector icon set (`{components.icon-set}`); a final 20px stroke pass is still pending.
- Blob paths in `design.css` are placeholders chosen by eye; the final illustration set may replace them with named assets.
- Motion timings beyond the busy-dot pulse (150–200ms ease suggested) are not yet specified per component.
- Native (React Native) mapping is implemented in `apps/mobile/src/theme.ts` (palette, fonts, persisted toggle, square radii, dock layout); verify on device after theme changes.
- Contrast of `{colors.text-faint}` on paper is below 4.5:1 by design (disabled/placeholder only); do not use it for body text.
- Empty/first-run illustration copy is illustrative; final product copy lives in the app.
- No data-visualization palette is defined (out of scope); charts should use ink + emerald steps only.
- `npx @google/design.md lint` reports warnings for sub-tokens its schema does not model yet (`border`, `shadow`, `ring`, `motion`, `geometry`, …) and for raw ramp tokens that components do not reference directly. These are intentional and mirror the getdesign reference templates; errors are at zero.
