export function EmptyState({
  hasSources,
  onOpenKnowledgeBase,
}: {
  hasSources: boolean
  onOpenKnowledgeBase: () => void
}) {
  return (
    <div className="empty">
      <div className="empty-cell cell-rag">
        <div className="sketch sketch-rag" aria-hidden="true">
          <i style={{ width: '75%' }} />
          <span className="sketch-line">
            <i style={{ width: '45%' }} />
            <i style={{ width: '28%' }} />
            <b />
          </span>
          <i style={{ width: '83%' }} />
          <span className="sketch-line">
            <i style={{ width: '60%' }} />
            <b />
          </span>
          <i style={{ width: '38%' }} />
        </div>
        <div className="empty-foot">
          <p className="empty-caption">
            Checks your documents, cites its sources
          </p>
          {!hasSources && (
            <button type="button" className="link-button empty-action" onClick={onOpenKnowledgeBase}>
              Add documents to your knowledge base →
            </button>
          )}
        </div>
      </div>
      <div className="empty-cell cell-baseline">
        <div className="sketch sketch-baseline" aria-hidden="true">
          <i style={{ width: '72%' }} />
          <span className="sketch-line">
            <i style={{ width: '18%' }} />
            <i className="mark-red" style={{ width: '48%' }} />
            <i style={{ width: '12%' }} />
          </span>
          <i style={{ width: '81%' }} />
          <span className="sketch-line">
            <i className="mark-yellow" style={{ width: '54%' }} />
            <i style={{ width: '23%' }} />
          </span>
          <i style={{ width: '43%' }} />
        </div>
        <p className="empty-caption">
          Answers from memory, then gets fact-checked
        </p>
      </div>
    </div>
  )
}
