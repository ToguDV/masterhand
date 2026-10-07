/**
 * Selectable color themes (issue #124).
 *
 * One shared definition for both clients so web (`data-palette` CSS blocks)
 * and mobile (`paletteFor`) can never drift: each palette tints the accent
 * family plus a subtle surface/blob/selection tint while the paper/ink
 * identity (canvas, text, hairlines) stays shared. Warning/danger stay global;
 * success keeps the emerald "ok" meaning on every palette.
 */

export type PaletteID =
  | "emerald"
  | "amber"
  | "rose"
  | "fuchsia"
  | "violet"
  | "indigo"
  | "blue"
  | "cyan"
  | "teal"
  | "lime"
  | "orange"
  | "crimson"
  | "slate"

export interface PaletteAccents {
  accent: string
  accentStrong: string
  accentSoft: string
  accentLine: string
  onAccent: string
  bubbleUser: string
  bubbleUserText: string
  /** Subtle tint of the neutral surface-muted, never a flat hue fill. */
  surfaceMuted: string
  blob: string
  selection: string
}

export interface PaletteEntry {
  label: string
  light: PaletteAccents
  dark: PaletteAccents
}

export const DEFAULT_PALETTE: PaletteID = "emerald"

export const PALETTES: Record<PaletteID, PaletteEntry> = {
  emerald: {
    label: "Emerald",
    light: {
      accent: "#0B6B53",
      accentStrong: "#085041",
      accentSoft: "#D9EAE3",
      accentLine: "rgba(11, 107, 83, 0.35)",
      onAccent: "#FFFFFF",
      bubbleUser: "#085041",
      bubbleUserText: "#FFFFFF",
      surfaceMuted: "#F2F2EE",
      blob: "#D9EAE3",
      selection: "rgba(11, 107, 83, 0.18)",
    },
    dark: {
      accent: "#3ED8A8",
      accentStrong: "#8BE9C9",
      accentSoft: "rgba(62, 216, 168, 0.14)",
      accentLine: "rgba(62, 216, 168, 0.35)",
      onAccent: "#04140E",
      bubbleUser: "#06372C",
      bubbleUserText: "#D9EAE3",
      surfaceMuted: "#1C1C1A",
      blob: "#17302A",
      selection: "rgba(62, 216, 168, 0.25)",
    },
  },
  amber: {
    label: "Amber",
    light: {
      accent: "#8A5A00",
      accentStrong: "#6B4500",
      accentSoft: "#F5E8C8",
      accentLine: "rgba(138, 90, 0, 0.35)",
      onAccent: "#FFFFFF",
      bubbleUser: "#6B4500",
      bubbleUserText: "#FFFFFF",
      surfaceMuted: "#F4EFE2",
      blob: "#F5E8C8",
      selection: "rgba(138, 90, 0, 0.18)",
    },
    dark: {
      accent: "#E3B341",
      accentStrong: "#F0C868",
      accentSoft: "rgba(227, 179, 65, 0.14)",
      accentLine: "rgba(227, 179, 65, 0.35)",
      onAccent: "#0C0C0B",
      bubbleUser: "#4A3603",
      bubbleUserText: "#F5E8C8",
      surfaceMuted: "#211C11",
      blob: "#2B2413",
      selection: "rgba(227, 179, 65, 0.25)",
    },
  },
  rose: {
    label: "Rose",
    light: {
      accent: "#AD1457",
      accentStrong: "#8A0F43",
      accentSoft: "#F9DCE6",
      accentLine: "rgba(173, 20, 87, 0.35)",
      onAccent: "#FFFFFF",
      bubbleUser: "#8A0F43",
      bubbleUserText: "#FFFFFF",
      surfaceMuted: "#F5EEEC",
      blob: "#F9DCE6",
      selection: "rgba(173, 20, 87, 0.16)",
    },
    dark: {
      accent: "#F48FB1",
      accentStrong: "#F8BBD0",
      accentSoft: "rgba(244, 143, 177, 0.14)",
      accentLine: "rgba(244, 143, 177, 0.35)",
      onAccent: "#0C0C0B",
      bubbleUser: "#57132C",
      bubbleUserText: "#F9DCE6",
      surfaceMuted: "#221A1D",
      blob: "#33202A",
      selection: "rgba(244, 143, 177, 0.25)",
    },
  },
  fuchsia: {
    label: "Fuchsia",
    light: {
      accent: "#A21CAF",
      accentStrong: "#86198F",
      accentSoft: "#F3D4F7",
      accentLine: "rgba(162, 28, 175, 0.35)",
      onAccent: "#FFFFFF",
      bubbleUser: "#86198F",
      bubbleUserText: "#FFFFFF",
      surfaceMuted: "#F4EEF4",
      blob: "#F3D4F7",
      selection: "rgba(162, 28, 175, 0.16)",
    },
    dark: {
      accent: "#E879F9",
      accentStrong: "#F0ABFC",
      accentSoft: "rgba(232, 121, 249, 0.14)",
      accentLine: "rgba(232, 121, 249, 0.35)",
      onAccent: "#0C0C0B",
      bubbleUser: "#4E145B",
      bubbleUserText: "#F3D4F7",
      surfaceMuted: "#211A22",
      blob: "#2E1F33",
      selection: "rgba(232, 121, 249, 0.25)",
    },
  },
  violet: {
    label: "Violet",
    light: {
      accent: "#6D28D9",
      accentStrong: "#5B21B6",
      accentSoft: "#E3D7FA",
      accentLine: "rgba(109, 40, 217, 0.35)",
      onAccent: "#FFFFFF",
      bubbleUser: "#5B21B6",
      bubbleUserText: "#FFFFFF",
      surfaceMuted: "#F0EDF5",
      blob: "#E3D7FA",
      selection: "rgba(109, 40, 217, 0.16)",
    },
    dark: {
      accent: "#A78BFA",
      accentStrong: "#C4B5FD",
      accentSoft: "rgba(167, 139, 250, 0.14)",
      accentLine: "rgba(167, 139, 250, 0.35)",
      onAccent: "#0C0C0B",
      bubbleUser: "#2E1B69",
      bubbleUserText: "#E3D7FA",
      surfaceMuted: "#1D1A24",
      blob: "#282136",
      selection: "rgba(167, 139, 250, 0.25)",
    },
  },
  indigo: {
    label: "Indigo",
    light: {
      accent: "#4338CA",
      accentStrong: "#3730A3",
      accentSoft: "#DCD9F9",
      accentLine: "rgba(67, 56, 202, 0.35)",
      onAccent: "#FFFFFF",
      bubbleUser: "#3730A3",
      bubbleUserText: "#FFFFFF",
      surfaceMuted: "#EEEEF5",
      blob: "#DCD9F9",
      selection: "rgba(67, 56, 202, 0.16)",
    },
    dark: {
      accent: "#818CF8",
      accentStrong: "#A5B4FC",
      accentSoft: "rgba(129, 140, 248, 0.14)",
      accentLine: "rgba(129, 140, 248, 0.35)",
      onAccent: "#0C0C0B",
      bubbleUser: "#23265E",
      bubbleUserText: "#DCD9F9",
      surfaceMuted: "#1A1C24",
      blob: "#232640",
      selection: "rgba(129, 140, 248, 0.25)",
    },
  },
  blue: {
    label: "Blue",
    light: {
      accent: "#1D4ED8",
      accentStrong: "#1E40AF",
      accentSoft: "#D5E1FA",
      accentLine: "rgba(29, 78, 216, 0.35)",
      onAccent: "#FFFFFF",
      bubbleUser: "#1E40AF",
      bubbleUserText: "#FFFFFF",
      surfaceMuted: "#EDF0F5",
      blob: "#D5E1FA",
      selection: "rgba(29, 78, 216, 0.16)",
    },
    dark: {
      accent: "#60A5FA",
      accentStrong: "#93C5FD",
      accentSoft: "rgba(96, 165, 250, 0.14)",
      accentLine: "rgba(96, 165, 250, 0.35)",
      onAccent: "#0C0C0B",
      bubbleUser: "#16294D",
      bubbleUserText: "#D5E1FA",
      surfaceMuted: "#191D24",
      blob: "#1F2A40",
      selection: "rgba(96, 165, 250, 0.25)",
    },
  },
  cyan: {
    label: "Cyan",
    light: {
      accent: "#0E7490",
      accentStrong: "#155E75",
      accentSoft: "#CDEFF8",
      accentLine: "rgba(14, 116, 144, 0.35)",
      onAccent: "#FFFFFF",
      bubbleUser: "#155E75",
      bubbleUserText: "#FFFFFF",
      surfaceMuted: "#ECF1F3",
      blob: "#CDEFF8",
      selection: "rgba(14, 116, 144, 0.16)",
    },
    dark: {
      accent: "#22D3EE",
      accentStrong: "#67E8F9",
      accentSoft: "rgba(34, 211, 238, 0.14)",
      accentLine: "rgba(34, 211, 238, 0.35)",
      onAccent: "#0C0C0B",
      bubbleUser: "#0B3540",
      bubbleUserText: "#CDEFF8",
      surfaceMuted: "#161E21",
      blob: "#162E35",
      selection: "rgba(34, 211, 238, 0.25)",
    },
  },
  teal: {
    label: "Teal",
    light: {
      accent: "#0F766E",
      accentStrong: "#115E59",
      accentSoft: "#C9EDE9",
      accentLine: "rgba(15, 118, 110, 0.35)",
      onAccent: "#FFFFFF",
      bubbleUser: "#115E59",
      bubbleUserText: "#FFFFFF",
      surfaceMuted: "#EDF1F0",
      blob: "#C9EDE9",
      selection: "rgba(15, 118, 110, 0.16)",
    },
    dark: {
      accent: "#2DD4BF",
      accentStrong: "#5EEAD4",
      accentSoft: "rgba(45, 212, 191, 0.14)",
      accentLine: "rgba(45, 212, 191, 0.35)",
      onAccent: "#0C0C0B",
      bubbleUser: "#07332E",
      bubbleUserText: "#C9EDE9",
      surfaceMuted: "#161E1D",
      blob: "#14302D",
      selection: "rgba(45, 212, 191, 0.25)",
    },
  },
  lime: {
    label: "Lime",
    light: {
      accent: "#4D7C0F",
      accentStrong: "#3F6212",
      accentSoft: "#E4F0C9",
      accentLine: "rgba(77, 124, 15, 0.35)",
      onAccent: "#FFFFFF",
      bubbleUser: "#3F6212",
      bubbleUserText: "#FFFFFF",
      surfaceMuted: "#F0F2E8",
      blob: "#E4F0C9",
      selection: "rgba(77, 124, 15, 0.16)",
    },
    dark: {
      accent: "#A3E635",
      accentStrong: "#BEF264",
      accentSoft: "rgba(163, 230, 53, 0.14)",
      accentLine: "rgba(163, 230, 53, 0.35)",
      onAccent: "#0C0C0B",
      bubbleUser: "#2A3A08",
      bubbleUserText: "#E4F0C9",
      surfaceMuted: "#1C2014",
      blob: "#26331A",
      selection: "rgba(163, 230, 53, 0.25)",
    },
  },
  orange: {
    label: "Orange",
    light: {
      accent: "#C2410C",
      accentStrong: "#9A3412",
      accentSoft: "#F9DFC9",
      accentLine: "rgba(194, 65, 12, 0.35)",
      onAccent: "#FFFFFF",
      bubbleUser: "#9A3412",
      bubbleUserText: "#FFFFFF",
      surfaceMuted: "#F4EEE8",
      blob: "#F9DFC9",
      selection: "rgba(194, 65, 12, 0.16)",
    },
    dark: {
      accent: "#FB923C",
      accentStrong: "#FDBA74",
      accentSoft: "rgba(251, 146, 60, 0.14)",
      accentLine: "rgba(251, 146, 60, 0.35)",
      onAccent: "#0C0C0B",
      bubbleUser: "#4E2208",
      bubbleUserText: "#F9DFC9",
      surfaceMuted: "#221A14",
      blob: "#33220F",
      selection: "rgba(251, 146, 60, 0.25)",
    },
  },
  crimson: {
    label: "Crimson",
    light: {
      accent: "#B3261E",
      accentStrong: "#8C1D18",
      accentSoft: "#F6D5D2",
      accentLine: "rgba(179, 38, 30, 0.35)",
      onAccent: "#FFFFFF",
      bubbleUser: "#8C1D18",
      bubbleUserText: "#FFFFFF",
      surfaceMuted: "#F4EDEC",
      blob: "#F6D5D2",
      selection: "rgba(179, 38, 30, 0.16)",
    },
    dark: {
      accent: "#F08A82",
      accentStrong: "#F5B3AD",
      accentSoft: "rgba(240, 138, 130, 0.14)",
      accentLine: "rgba(240, 138, 130, 0.35)",
      onAccent: "#0C0C0B",
      bubbleUser: "#4D130F",
      bubbleUserText: "#F6D5D2",
      surfaceMuted: "#221A19",
      blob: "#331F1D",
      selection: "rgba(240, 138, 130, 0.25)",
    },
  },
  slate: {
    label: "Slate",
    light: {
      accent: "#475569",
      accentStrong: "#334155",
      accentSoft: "#DDE3EA",
      accentLine: "rgba(71, 85, 105, 0.35)",
      onAccent: "#FFFFFF",
      bubbleUser: "#334155",
      bubbleUserText: "#FFFFFF",
      surfaceMuted: "#EFF0F2",
      blob: "#DDE3EA",
      selection: "rgba(71, 85, 105, 0.16)",
    },
    dark: {
      accent: "#94A3B8",
      accentStrong: "#CBD5E1",
      accentSoft: "rgba(148, 163, 184, 0.14)",
      accentLine: "rgba(148, 163, 184, 0.35)",
      onAccent: "#0C0C0B",
      bubbleUser: "#222B38",
      bubbleUserText: "#DDE3EA",
      surfaceMuted: "#1B1E23",
      blob: "#232B36",
      selection: "rgba(148, 163, 184, 0.25)",
    },
  },
}

/** Ordered ids for pickers (emerald first, the rest alphabetical). */
export const PALETTE_IDS: PaletteID[] = [
  "emerald",
  "amber",
  "blue",
  "crimson",
  "cyan",
  "fuchsia",
  "indigo",
  "lime",
  "orange",
  "rose",
  "slate",
  "teal",
  "violet",
]

/** Stored palette id; unknown or missing values fall back to emerald. */
export function resolvePalette(stored: string | null | undefined): PaletteID {
  if (stored && Object.hasOwn(PALETTES, stored)) return stored as PaletteID
  return DEFAULT_PALETTE
}
