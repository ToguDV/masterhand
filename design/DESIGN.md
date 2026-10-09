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
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.body-md}"
    rounded: "{rounded.md}"
    padding: "10px 12px"
    border: "1px solid {colors.hairline-strong}"
    height: 44px
  text-field-focused:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    border: "1px solid {colors.accent}"
    ring: "0 0 0 3px {colors.accent-soft}"
  text-area:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.body-md}"
    rounded: "{rounded.lg}"
    padding: "{spacing.sm} {spacing.md}"
    border: "1px solid {colors.hairline-strong}"
  select-trigger:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.sm}"
    padding: "6px 10px"
    border: "1px solid {colors.hairline-strong}"
  search-field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.body-md}"
    rounded: "{rounded.lg}"
    padding: "10px 12px 10px 36px"
    border: "1px solid {colors.hairline-strong}"
  composer-bar:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.text}"
    typography: "{typography.body-md}"
    padding: "{spacing.sm} {spacing.md} {spacing.md}"
    border: "1px solid {colors.hairline} (top)"
  top-bar:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.text}"
    typography: "{typography.body-md-medium}"
    padding: "0 {spacing.md}"
    border: "1px solid {colors.hairline} (bottom)"
    height: 56px
  sidebar:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.text}"
    typography: "{typography.body-md}"
    padding: "{spacing.sm}"
    border: "1px solid {colors.hairline} (right)"
    width: 272px
  session-item:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    typography: "{typography.body-md}"
    rounded: "{rounded.md}"
    padding: "10px 12px"
  session-item-active:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.text}"
    indicator: "2px left bar in {colors.accent}"
  filter-pill:
    backgroundColor: "transparent"
    textColor: "{colors.text-muted}"
    typography: "{typography.caption}"
    rounded: "{rounded.full}"
    padding: "4px 10px"
    border: "1px solid {colors.hairline}"
  filter-pill-active:
    backgroundColor: "{colors.text}"
    textColor: "{colors.canvas}"
    typography: "{typography.caption}"
    rounded: "{rounded.full}"
    padding: "4px 10px"
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
    border: "1px solid {colors.danger-line}"
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
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent}"
    typography: "{typography.caption}"
    rounded: "{rounded.full}"
    padding: "3px 10px"
  chip-warning:
    backgroundColor: "{colors.warning-soft}"
    textColor: "{colors.warning}"
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
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent}"
    typography: "{typography.code-sm}"
    rounded: "{rounded.full}"
    padding: "3px 10px"
  banner-warning:
    backgroundColor: "{colors.warning-soft}"
    textColor: "{colors.warning}"
    typography: "{typography.body-sm}"
    padding: "8px {spacing.md}"
    border: "1px solid {colors.warning-line} (bottom)"
  banner-danger:
    backgroundColor: "{colors.danger-soft}"
    textColor: "{colors.danger}"
    typography: "{typography.body-sm}"
    padding: "8px {spacing.md}"
    border: "1px solid {colors.danger-line} (bottom)"
  banner-info:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent}"
    typography: "{typography.body-sm}"
    padding: "8px {spacing.md}"
    border: "1px solid {colors.accent-line} (bottom)"
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
    border: "1px solid {colors.warning-line}"
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
    border: "1px solid {colors.accent-line}"
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
    border: "2px solid {colors.accent} (bottom)"
  option-row:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
    padding: "10px 12px"
    border: "1px solid {colors.hairline-strong}"
  option-row-selected:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.text}"
    border: "1px solid {colors.accent}"
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
- Exactly ONE accent hue: deep emerald (`{colors.accent}`), budgeted to <10% of any screen (primary CTA, active state, focus ring, small tint)
- Editorial type pairing: **Fraunces** for display and the wordmark, **Instrument Sans** for all UI and body, **JetBrains Mono** for code — all swappable through three CSS variables
- Organic decoration in empty rooms only: `{components.deco-blob}`, `{components.deco-dots}`, `{components.deco-hatch}`, `{components.deco-curve}`
- Flat depth: hairlines and surface steps do the work; shadows reserved for overlays
- Mobile-first: 44px touch targets, bottom sheets for management dialogs, drawer navigation — then progressively enhanced for desktop
- Blocking requests live in the flow: permission requests and agent questions render inline in the transcript (never as modals), and a multi-question form carries a tab index on top
- The chat transcript is sacred: full width of a 768px column, zero decoration behind messages

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

A theme repaints the full surface/text/hairline/code/syntax set plus the accent family and a matching `surface-muted`/`blob`/`selection` tint. Only color tokens change — layout, spacing and radii stay identical across themes. The semantic warning/danger/success tokens stay shared. Light accents are dark shades (readable on paper), dark accents are light shades (readable on charcoal); unknown stored values (including the legacy accent-color ids) fall back to paper.

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

Function names follow the active palette (the dark accent reads on dark code in every theme); the rest is fixed. Diff add/remove rows keep their semantic row colors — only context lines highlight. Unknown languages render plain, never broken.

### Brand & Accent
- **Deep Emerald** (`{colors.accent}`): the single accent. Primary buttons, active filter pill text, focus rings, branch chips, connection state.
- **Emerald Strong** (`{colors.accent-strong}`): pressed states and hover on dark.
- **Emerald Soft** (`{colors.accent-soft}`): 10–15% tint surfaces — blobs, chip fills, focus glow. Never used as a large page background.

### Neutral warm (light) / charred (dark)
- **Paper** (`{colors.paper}`): warm off-white canvas; pure white is reserved for elevated surfaces so they read as "sheets on a desk".
- **Ink 950…500** (`{colors.ink-950}` … `{colors.ink-500}`): the black ramp; also the source of the alt theme backgrounds.
- **Grey 500…50** (`{colors.grey-500}` … `{colors.grey-50}`): secondary text and dividers.

### Semantic
- **Warning**, **Danger**, **Success** are desaturated to sit inside the editorial palette; they never compete with the accent for attention. Busy dots and warning banners use warning; destructive buttons and error tool cards use danger.

### Color rules
- Accent budget: if removing every emerald pixel would break comprehension, there is too much of it.
- No gradients, no second hue. The only permitted color besides the ramps is a translucent tint of emerald or of a semantic color.
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
- **Sidebar**: 272px, collapses to a drawer below 768px.
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

**`button-ghost`** — quiet tertiary action (Back, Sign out, panel triggers).
- Transparent, `{colors.text-muted}` text, `{rounded.sm}`, compact padding.

**`button-danger`** — destructive (Reject, Delete, Remove).
- `{colors.danger-soft}` background, `{colors.danger}` text, `{colors.danger-line}` border. Never filled solid red.

**`button-icon`** — square 40×40 (44×44 on touch), glyph or SVG at 18–20px, `{colors.text-muted}`.

### Forms

**`text-field`** — default input, 44px height, `{colors.surface}` background, `{colors.hairline-strong}` border, `{rounded.md}`. **`text-field-focused`** switches the border to `{colors.accent}` and adds a 3px `{colors.accent-soft}` ring. **`text-area`** uses `{rounded.lg}` for multi-line input (composer, prompts). **`select-trigger`** is the compact dropdown (agent, model, effort); the effort trigger carries a brain glyph for reasoning-effort variants and a generic sliders glyph otherwise. **`search-field`** is a `{rounded.lg}` input with a leading glyph (session filter, model search). **`composer-bar`** is the sticky bottom surface: a context bar above the input — the workspace menu — and the message textarea with its context selectors (agent, model, effort, auto-accept) below it.

### Navigation

**`top-bar`** — 56px, canvas background, bottom hairline. Mobile: back chevron when a session is open, truncated title, status dot, overflow menu. Desktop: title, connection state, sessions count.

**`sidebar`** — 272px canvas column, right hairline. Contains the session list, its filters and the new-session `+` action (its popover hosts the isolated-worktree option); workspace switching lives in the composer bar. Below 768px it becomes a drawer opened from the top bar, with the overlay scrim.

**`session-item`** — full-width row, `{rounded.md}`, title in `{typography.heading-4}`, meta line in `{typography.session-meta}` (directory · relative time). **`session-item-active`** steps the surface and draws a 2px `{colors.accent}` indicator on the left.

**`filter-pill`** / **`filter-pill-active`** — All / Isolated / Standard. The active pill is filled with `{colors.text}` on `{colors.canvas}` (ink-on-paper inversion), not with emerald; emerald stays budgeted for actions.

**`workspace-picker`** — compact menu in the composer bar: shows the current workspace and, on click, the workspace list plus the add/remove management actions.

### Conversation

**`user-bubble`** — right-aligned, deep-emerald fill: `{colors.bubble-user}` background, `{colors.bubble-user-text}` text, `{rounded.lg}`, max 85% width. It is the only filled transcript surface, so it uses the accent ramp **darker** (emerald-800 light / emerald-900 dark) instead of the inverted ink pair, which made every user message the brightest element on a dark canvas.

**`assistant-block`** — no bubble. Agent label in `{typography.micro}` uppercase + `{colors.text-muted}`, body in `{typography.body-md}`, max 68ch. Code, tool cards and blocking-request cards stack inside the block at full column width.

**`agent-label`** / **`session-meta`** — micro-label and mono metadata as described in Typography.

**`permission-card`** — a permission request renders **inline in the transcript**, inside the agent block that raised it: `{colors.surface}`, `{colors.warning-line}` border, `{rounded.lg}`. Header = busy dot + "Permission requested"; body = one-line context + the command in a `code-block`; actions = Allow once (`button-primary`), Always allow (`button-secondary`), Reject (`button-danger`). Once answered it collapses to `permission-card-resolved`: a quiet caption row (state dot + "Allowed once · 2m ago") that stays in the flow as history. It is never a modal — the request belongs to the agent turn that asked for it.

**`question-card`** — an agent question renders **inline in the transcript**, same placement rules: `{colors.surface}`, `{colors.accent-line}` border, `{rounded.lg}`. A single question shows the prompt plus `option-row`s; a **multi-question form shows a top index** (`question-index` tabs — one per question plus a final Submit step) so the user can jump straight to any question, with the active tab underlined in `{colors.accent}` and an error dot on questions that fail validation. The footer is Next/Submit (`button-primary`) plus Dismiss (`button-ghost`).

**`goal-review`** — Goal Mode's critic/judge work renders **inline in the transcript** (their internal sessions never list in the sidebar): a `{colors.surface}` section with `{rounded.lg}` holds one collapsible round row per review (`Round N`, verdict chip, one-line summary; the latest round open, older ones expand on demand). Bodies are a `critic-block` (argument plus issue rows with a severity chip and evidence) and a `verdict-block` (decision chip, reasoning and the required changes). A completion marker in an assistant message becomes a `goal-report` card with a 3px left rule (`{colors.accent}`, `{colors.warning}` when blocked), the summary and an evidence list; critique/verdict markers found in a message reuse the same blocks inside a `tool-card`-style shell. The control strip above the composer stays a single line — state, `round N/M`, activity, Pause/Resume/Cancel in `button-secondary`/`button-primary`/`button-danger` — never a second copy of the history.

### Tools

**`tool-card`** — the agent's work unit: `{colors.surface}`, `{colors.hairline}` border, `{rounded.lg}`, collapsed to a 40px `tool-card-header` (glyph, title, status, chevron) and expanded to raw output. Status is a dot (`{components.status-dot-*}`), never a colored card. **`tool-card-error`** swaps its border to `{colors.danger-line}` and the status dot to danger.

**`code-block`** — dark `{colors.code-surface}` in both themes, `{rounded.md}`, `{typography.code-md}`, optional `code-block-header` with the language or command path. **`diff-add`** / **`diff-remove`** render as emerald/danger tinted rows with mono gutters.

### Status & Chips

**`status-dot-idle`** (`{colors.hairline-strong}`), **`status-dot-busy`** (warning, pulsing), **`status-dot-connected`** (success). Dots are 8px, always paired with a text label in tooltips or captions.

**`chip-neutral`**, **`chip-accent`**, **`chip-warning`**, **`chip-danger`**, **`branch-chip`** — pill badges at 3px/10px padding in `{typography.caption}`; branch chips use `{typography.code-sm}`.

### Feedback

**`banner-warning`** / **`banner-danger`** / **`banner-info`** — full-width strips under the top bar, tinted background + bottom border in the semantic color. They are dismissible by tap and never modal.

**`toast`** — inverted ink pill for confirmations ("Copied", "Session deleted"), `{rounded.md}`, overlay shadow, auto-dismiss.

**`empty-state`** — the decoration showcase: a `{components.deco-blob}` plus `{components.deco-dots}` at low opacity behind a `{typography.heading-2}` line, one `{typography.body-md}` sentence and at most one button. Used for: no sessions, no workspace, no messages yet, empty panel.

### Overlays

**`dialog`** — `{components.dialog-overlay}` scrim + surface card, `{rounded.xl}`, max 440px. Reserved for **management flows the agent cannot raise**: add/remove workspace, plus the `choice-modal`. On mobile it is a bottom sheet with 44px actions. Blocking agent requests (permission, questions) are never dialogs — they render inline in the transcript.

**`choice-modal`** — a question raised by a session that is **not the one on screen** still needs an answer, or its agent stays blocked invisibly: the same content as `question-card`, presented as a modal with an "open session" action. Once that session is opened, the question lives inline in its transcript.

**`side-panel`** — right sheet (360px) for side questions, **Run & preview** and audit; full-width on mobile. The Run & preview panel keeps one internal tablist (`Run | Preview`, active tab underlined in accent) because both views drive the same dev-server lifecycle: opening it lands on Preview when the tunnel is running, otherwise on Run, and starting/stopping never forces a tab switch.

**`login-card`** — centered card, `{rounded.xxl}`, with a blob behind it and a dot field at its base; contains the wordmark, one field and one primary button. The single most decorated screen in the product.

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

### Don't
- Don't introduce a second accent hue, gradients, or colored glows
- Don't use emerald as a large background fill or flood a screen with it
- Don't place blobs, dots or hatching behind text, diffs, code or tool output
- Don't use serif for body copy, buttons, labels or anything below 26px
- Don't stack multiple decorations: one blob OR one dot field OR one hatch strip per composition, plus at most one thin curve
- Don't use pill radii for cards, inputs or buttons — pills are only filters, chips and dots
- Don't animate decoration; only functional pulses (busy dot) and 150–200ms state transitions
- Don't invent a separate mobile look: same tokens, same components, adaptive layout
- Don't turn a permission request or an agent question into a modal or bottom sheet — only a question raised in a *different* session uses `choice-modal`

## Responsive Behavior

### Breakpoints
| Name | Width | Key Changes |
|---|---|---|
| Mobile | < 640px | Single column. Sidebar becomes a drawer. Management dialogs and side panels become bottom sheets; permission and question cards stay inline. Display hero 40px, display-lg 32px, heading-1 26px. Decoration reduced to one element per screen. |
| Large mobile | 640–767px | Message column takes full width with 24px gutters; submission rows gain secondary actions. |
| Tablet | 768–1023px | Sidebar docks at 272px. Two-column form rows. Chat column centers with 32px gutters. Top-bar secondary info appears. |
| Desktop | 1024–1279px | Preview/docs grid 3-up. Panels dock to the right at 360px. Full decoration composition on hero/login/empty states. |
| Wide | ≥ 1280px | 1200px container, display tokens at full size. |

### Touch Targets
- All buttons and rows render at ≥44px effective height on touch (`button-icon` grows 40→44px)
- Filter pills grow from 32px to 44px on mobile
- Bottom sheets keep their primary action within the lower third of the screen

### Collapsing Strategy
- **Sidebar**: drawer below 768px, opened from the top-bar workspace button; scrim uses `{components.dialog-overlay}`
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

- Tool glyph set is a placeholder (single-character glyphs); a proper 20px stroke icon set is pending.
- Blob paths in `design.css` are placeholders chosen by eye; the final illustration set may replace them with named assets.
- Motion timings beyond the busy-dot pulse (150–200ms ease suggested) are not yet specified per component.
- Native (React Native) mapping is descriptive only: `design.css` tokens must be ported to `apps/mobile/src/theme.ts` when this design is implemented.
- Contrast of `{colors.text-faint}` on paper is below 4.5:1 by design (disabled/placeholder only); do not use it for body text.
- Empty/first-run illustration copy is illustrative; final product copy lives in the app.
- No data-visualization palette is defined (out of scope); charts should use ink + emerald steps only.
- `npx @google/design.md lint` reports warnings for sub-tokens its schema does not model yet (`border`, `shadow`, `ring`, `motion`, `geometry`, …) and for raw ramp tokens that components do not reference directly. These are intentional and mirror the getdesign reference templates; errors are at zero.
