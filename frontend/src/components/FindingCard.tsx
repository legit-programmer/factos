import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import type { Finding } from '../api/types'
import { evidenceLabel } from '../lib/text'
import { Swatch } from './Marks'
import { Excerpt } from './Excerpt'

export function FindingCard({
  findings,
  index,
  onIndex,
}: {
  findings: Finding[]
  index: number
  onIndex: (index: number) => void
}) {
  const [openEvidence, setOpenEvidence] = useState<string | null>(null)
  const finding = findings[index]
  if (!finding) return null
  const contradicted = finding.verdict === 'contradicted'
  const go = (step: number) => {
    setOpenEvidence(null)
    onIndex((index + step + findings.length) % findings.length)
  }

  return (
    <article className={`finding-card is-${finding.highlight}`} aria-live="polite">
      <header>
        <span className="finding-kind">
          <Swatch kind={finding.highlight} />
          {contradicted ? 'Contradicted' : 'Unverifiable'}
        </span>
        <span className="finding-position">
          {index + 1} of {findings.length}
        </span>
        <span className="finding-nav">
          <button type="button" onClick={() => go(-1)} aria-label="Previous finding" disabled={findings.length < 2}>
            <ChevronLeft size={16} />
          </button>
          <button type="button" onClick={() => go(1)} aria-label="Next finding" disabled={findings.length < 2}>
            <ChevronRight size={16} />
          </button>
        </span>
      </header>
      <div className="finding-body">
        <section>
          <h4>Model said</h4>
          <p className="finding-quote">{finding.quote}</p>
        </section>
        <section>
          <h4>{contradicted ? 'Your sources say' : 'Why it’s flagged'}</h4>
          <p className="finding-quote">
            {contradicted ? (finding.correction ?? finding.reason) : finding.reason}
          </p>
          {!contradicted && finding.correction && (
            <p className="finding-narrower">
              <span>What your sources support:</span> {finding.correction}
            </p>
          )}
          {finding.evidence.length === 0 && !contradicted && (
            <p className="finding-source muted">No passage in your sources settles this.</p>
          )}
          {finding.evidence.map((evidence) => (
            <div key={evidence.chunk_id}>
              <button
                type="button"
                className="finding-source"
                aria-expanded={openEvidence === evidence.chunk_id}
                onClick={() => setOpenEvidence(openEvidence === evidence.chunk_id ? null : evidence.chunk_id)}
              >
                {evidenceLabel(evidence) + '\u00a0→'}
              </button>
              {openEvidence === evidence.chunk_id && <Excerpt evidence={evidence} />}
            </div>
          ))}
        </section>
      </div>
      {contradicted && finding.correction && <p className="finding-reason">{finding.reason}</p>}
    </article>
  )
}
