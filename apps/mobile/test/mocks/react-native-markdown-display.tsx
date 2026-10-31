import type { ReactNode } from "react"
import { Text } from "react-native"

/**
 * `@ronradtke/react-native-markdown-display` ships untransformed JSX in
 * `node_modules` (and drags ESM deps like `markdown-it`/`prism-react-renderer`),
 * which Jest cannot parse without transpiling a large dependency chain. The
 * mobile render tests only exercise how `MessageBubble` feeds text to it, so
 * this stub echoes the markdown source instead; real markdown rendering is
 * covered by the web `markdown.spec.ts` E2E.
 */
export const darkStyles: Record<string, unknown> = {}
export type MarkdownStyleMap = Record<string, unknown>

/** The real helper builds a markdown-it instance; tests never parse. */
export function createMarkdownIt(): Record<string, unknown> {
  return {}
}

export default function Markdown({ children }: { children?: ReactNode }) {
  return <Text>{children}</Text>
}
