// Small brand marks drawn inline so they inherit size and colour tokens.

export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="13" cy="16" r="8" fill="none" stroke="var(--ink)" strokeWidth="2.2" />
      <circle
        cx="19.5"
        cy="16"
        r="8"
        fill="none"
        stroke="var(--pink)"
        strokeWidth="2.2"
        strokeDasharray="2 2.7"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function GroundedDot({ size = 12 }: { size?: number }) {
  return <span className="dot-grounded" style={{ width: size, height: size }} aria-hidden="true" />
}

export function UngroundedDot({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" className="dot-ungrounded">
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="var(--pink)"
        strokeWidth="1.6"
        strokeDasharray="2 2.2"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function Swatch({ kind }: { kind: 'red' | 'yellow' }) {
  return <span className={`swatch swatch-${kind}`} aria-hidden="true" />
}
