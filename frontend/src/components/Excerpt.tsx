import type { Evidence } from '../api/types'

export function Excerpt({ evidence }: { evidence: Evidence }) {
  const url = evidence.locator.url ? String(evidence.locator.url) : null
  return (
    <blockquote className="excerpt">
      {evidence.excerpt}
      {url && /^https?:\/\//.test(url) && (
        <a href={url} target="_blank" rel="noreferrer noopener">
          Open page ↗
        </a>
      )}
    </blockquote>
  )
}
