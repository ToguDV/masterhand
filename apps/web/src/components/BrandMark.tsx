/**
 * The MasterHand blob mark from design/DESIGN.html: an organic emerald blob
 * with one chalk stroke. Decorative only, so it is hidden from assistive tech.
 */
export function BrandMark({ className = "mh-brand__mark" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden="true">
      <path
        d="M16.4 2.6c5.8-.6 11.6 3 13.2 8.6 1.6 5.6-1.2 11.8-6.4 14.6-5.2 2.8-12.2 2-16-2.6C3.4 18.6 3 12 6.6 8c2.6-3 6.2-5 9.8-5.4Z"
        fill="var(--mh-accent)"
      />
      <path
        d="M9.5 20.5c3.4-1.1 5.8-3.8 6.6-7.4"
        fill="none"
        stroke="var(--mh-canvas)"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  )
}
