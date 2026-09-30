import { AlertTriangle, Check, FileText, Globe, Loader2, RotateCcw, Trash2, Upload, X } from 'lucide-react'
import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react'
import { ApiError, api } from '../api/client'
import type { Source, SourceWarning } from '../api/types'
import { cleanTitle, hostPath } from '../lib/text'
import { useToast } from './Toast'

const EXTENSIONS = ['.pdf', '.docx', '.pptx', '.md']
const MAX_BYTES = 25 * 1024 * 1024

interface Upload {
  name: string
  state: 'uploading' | 'error' | 'duplicate'
  message?: string
}

export function describeWarnings(warnings: SourceWarning[]) {
  const lines: string[] = []
  const pages = warnings.filter((w) => w.code === 'no_extractable_text' && w.page != null).map((w) => w.page)
  const slides = warnings.filter((w) => w.code === 'no_extractable_text' && w.slide != null).map((w) => w.slide)
  if (pages.length) lines.push(`No extractable text on page${pages.length > 1 ? 's' : ''} ${pages.join(', ')}; not indexed.`)
  if (slides.length) lines.push(`No extractable text on slide${slides.length > 1 ? 's' : ''} ${slides.join(', ')}; not indexed.`)
  for (const w of warnings) {
    if (w.code === 'no_extractable_text' && (w.page != null || w.slide != null)) continue
    if (w.code === 'no_extractable_text' && w.url) lines.push(`No text found at ${hostPath(w.url)}.`)
    else if (w.code === 'skipped_url' && w.url) lines.push(`Skipped linked download ${hostPath(w.url)}.`)
    else if (w.code === 'page_limit') lines.push('Stopped at the 25-page crawl limit.')
    else lines.push(w.message ?? w.code ?? 'Extraction warning')
  }
  return lines
}

interface Props {
  sessionId: string | null
  sources: Source[]
  ensureSession: () => Promise<string>
  onChanged: () => void
  onClose: () => void
}

export function KnowledgeBase({ sessionId, sources, ensureSession, onChanged, onClose }: Props) {
  const toast = useToast()
  const [uploads, setUploads] = useState<Upload[]>([])
  const [dragging, setDragging] = useState(false)
  const [siteUrl, setSiteUrl] = useState('')
  const [paths, setPaths] = useState('')
  const [siteError, setSiteError] = useState<string | null>(null)
  const [siteBusy, setSiteBusy] = useState(false)
  const picker = useRef<HTMLInputElement>(null)
  const dialog = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    dialog.current?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const setUpload = (name: string, next: Upload | null) =>
    setUploads((all) => {
      const rest = all.filter((u) => u.name !== name)
      return next ? [...rest, next] : rest
    })

  const addFiles = async (list: FileList | File[]) => {
    const files = Array.from(list)
    if (!files.length) return
    let id: string
    try {
      id = sessionId ?? (await ensureSession())
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not create a session')
      return
    }
    for (const file of files) {
      const extension = file.name.slice(file.name.lastIndexOf('.')).toLowerCase()
      if (!EXTENSIONS.includes(extension)) {
        setUpload(file.name, {
          name: file.name,
          state: 'error',
          message: extension === '.doc' || extension === '.ppt'
            ? 'Legacy .doc/.ppt aren’t supported; save as .docx/.pptx.'
            : 'Only PDF, DOCX, PPTX and Markdown are supported.',
        })
        continue
      }
      if (file.size > MAX_BYTES) {
        setUpload(file.name, { name: file.name, state: 'error', message: 'Larger than the 25 MB limit.' })
        continue
      }
      setUpload(file.name, { name: file.name, state: 'uploading' })
      try {
        const result = await api.uploadSource(id, file)
        setUpload(file.name, result.deduplicated ? { name: file.name, state: 'duplicate', message: 'Already in this knowledge base.' } : null)
        onChanged()
      } catch (error) {
        setUpload(file.name, {
          name: file.name,
          state: 'error',
          message: error instanceof Error ? error.message : 'Upload failed',
        })
      }
    }
  }

  const addWebsite = async (event: FormEvent) => {
    event.preventDefault()
    setSiteError(null)
    const value = siteUrl.trim()
    if (!/^https?:\/\//i.test(value)) return setSiteError('Enter a full http(s):// address.')
    setSiteBusy(true)
    try {
      const id = sessionId ?? (await ensureSession())
      const includePaths = paths.split(',').map((p) => p.trim()).filter(Boolean)
      await api.addWebsite(id, value, includePaths)
      setSiteUrl('')
      setPaths('')
      onChanged()
    } catch (error) {
      if (error instanceof ApiError && error.code === 'firecrawl_unavailable')
        setSiteError('Website crawling isn’t enabled on this server (Firecrawl is not configured).')
      else if (error instanceof ApiError && error.code === 'unsafe_url')
        setSiteError('Only public http(s) websites can be crawled.')
      else setSiteError(error instanceof Error ? error.message : 'Could not start the crawl')
    } finally {
      setSiteBusy(false)
    }
  }

  const act = async (action: () => Promise<unknown>) => {
    try {
      await action()
      onChanged()
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Action failed')
    }
  }

  const onDrop = (event: DragEvent) => {
    event.preventDefault()
    setDragging(false)
    addFiles(event.dataTransfer.files)
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="kb-title" tabIndex={-1} ref={dialog}>
        <header className="modal-header">
          <div>
            <h2 id="kb-title">Knowledge base</h2>
            <p className="muted">The grounded answer and the fact check only use what’s indexed here.</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </header>

        <div
          className={`dropzone ${dragging ? 'is-dragging' : ''}`}
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <Upload size={20} strokeWidth={1.6} />
          <p>
            Drop files here or{' '}
            <button type="button" className="link-button" onClick={() => picker.current?.click()}>
              browse
            </button>
          </p>
          <small className="muted">Text-based PDF, DOCX, PPTX or Markdown · up to 25 MB · scanned pages aren’t read</small>
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            accept={EXTENSIONS.join(',')}
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files)
              e.target.value = ''
            }}
          />
        </div>

        <form className="website-form" onSubmit={addWebsite}>
          <label className="website-url">
            <Globe size={16} strokeWidth={1.6} />
            <input
              type="url"
              placeholder="https://docs.example.com"
              value={siteUrl}
              onChange={(e) => setSiteUrl(e.target.value)}
              aria-label="Website address"
            />
          </label>
          <input
            className="website-paths"
            placeholder="Paths, e.g. /docs/*"
            value={paths}
            onChange={(e) => setPaths(e.target.value)}
            aria-label="Include paths"
          />
          <button type="submit" className="button-secondary" disabled={siteBusy || !siteUrl.trim()}>
            {siteBusy ? 'Starting…' : 'Crawl site'}
          </button>
        </form>
        <p className="muted small-print">Crawls up to 25 pages on the same host, two links deep.</p>
        {siteError && <p className="form-error">{siteError}</p>}

        <ul className="source-list">
          {uploads.map((u) => (
            <li key={'upload-' + u.name} className={`source is-${u.state}`}>
              <FileText size={16} strokeWidth={1.6} />
              <div className="source-main">
                <span className="source-title">{u.name}</span>
                {u.message && <span className="source-detail">{u.message}</span>}
              </div>
              {u.state === 'uploading' ? (
                <span className="source-status">
                  <Loader2 size={13} className="spin" /> Uploading
                </span>
              ) : (
                <button type="button" className="icon-button" aria-label="Dismiss" onClick={() => setUpload(u.name, null)}>
                  <X size={14} />
                </button>
              )}
            </li>
          ))}
          {sources.map((source) => {
            const notes = describeWarnings(source.warnings)
            return (
              <li key={source.id} className={`source is-${source.status}`}>
                {source.kind === 'website' ? <Globe size={16} strokeWidth={1.6} /> : <FileText size={16} strokeWidth={1.6} />}
                <div className="source-main">
                  <span className="source-title" title={source.title}>
                    {source.kind === 'website' ? hostPath(source.title) : cleanTitle(source.title)}
                  </span>
                  {source.status === 'failed' && (
                    <span className="source-detail is-error">
                      {source.error === 'interrupted' ? 'Interrupted by a server restart.' : source.error || 'Processing failed.'}
                    </span>
                  )}
                  {notes.map((note) => (
                    <span key={note} className="source-detail">
                      <AlertTriangle size={11} /> {note}
                    </span>
                  ))}
                </div>
                <span className="source-status">
                  {source.status === 'processing' && (
                    <>
                      <Loader2 size={13} className="spin" /> Indexing
                    </>
                  )}
                  {source.status === 'ready' && (
                    <>
                      <Check size={13} /> Ready
                    </>
                  )}
                  {source.status === 'failed' && 'Failed'}
                </span>
                {source.status === 'failed' && sessionId && (
                  <button
                    type="button"
                    className="icon-button"
                    title="Retry"
                    aria-label={`Retry ${source.title}`}
                    onClick={() => act(() => api.retrySource(sessionId, source.id))}
                  >
                    <RotateCcw size={14} />
                  </button>
                )}
                {sessionId && (
                  <button
                    type="button"
                    className="icon-button"
                    title="Remove"
                    aria-label={`Remove ${source.title}`}
                    onClick={() => {
                      if (window.confirm(`Remove “${cleanTitle(source.title)}”? New questions won’t use it.`))
                        act(() => api.deleteSource(sessionId, source.id))
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </li>
            )
          })}
          {!sources.length && !uploads.length && <li className="source-empty muted">No documents yet.</li>}
        </ul>
        <p className="muted small-print">
          Sources added mid-conversation apply to new questions. Earlier answers keep the knowledge base they were
          written and checked against.
        </p>
      </div>
    </div>
  )
}
