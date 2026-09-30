import { ArrowUp, ImagePlus, Square, X } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useToast } from './Toast'

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp']
const MAX_IMAGES = 4
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

interface Props {
  busy: boolean
  canStop: boolean
  placeholder: string
  suggestions: string[]
  onSubmit: (text: string, files: File[]) => Promise<boolean>
  onStop: () => void
}

export function Composer({ busy, canStop, placeholder, suggestions, onSubmit, onStop }: Props) {
  const toast = useToast()
  const [text, setText] = useState('')
  const [files, setFiles] = useState<{ file: File; preview: string }[]>([])
  const [sending, setSending] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const el = input.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 180) + 'px'
  }, [text])

  const addFiles = (list: FileList | null) => {
    const chosen = Array.from(list ?? [])
    const accepted = chosen.filter((f) => IMAGE_TYPES.includes(f.type) && f.size <= MAX_IMAGE_BYTES)
    if (accepted.length < chosen.length) toast('Images must be JPEG, PNG or WebP, up to 10 MB each.')
    setFiles((current) => {
      const next = [...current, ...accepted.map((file) => ({ file, preview: URL.createObjectURL(file) }))]
      if (next.length > MAX_IMAGES) toast(`Up to ${MAX_IMAGES} images per question.`)
      next.slice(MAX_IMAGES).forEach((f) => URL.revokeObjectURL(f.preview))
      return next.slice(0, MAX_IMAGES)
    })
  }

  const send = async (value: string) => {
    const question = value.trim()
    if ((!question && !files.length) || busy || sending) return
    const attached = files
    setSending(true)
    setText('')
    setFiles([])
    const ok = await onSubmit(question, attached.map((f) => f.file))
    setSending(false)
    attached.forEach((f) => URL.revokeObjectURL(f.preview))
    if (!ok) {
      setText(value)
      setFiles(attached.map((f) => ({ file: f.file, preview: URL.createObjectURL(f.file) })))
    }
    input.current?.focus()
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (busy) {
      if (canStop) onStop()
      return
    }
    send(text)
  }

  const ready = Boolean(text.trim() || files.length) && !sending

  return (
    <div className="composer-wrap">
      {suggestions.length > 0 && (
        <div className="suggestions">
          {suggestions.map((s) => (
            <button type="button" key={s} className="chip" onClick={() => send(s)}>
              {s}
            </button>
          ))}
        </div>
      )}
      <form className={`composer ${busy ? 'is-busy' : ''}`} onSubmit={submit}>
        {files.length > 0 && (
          <div className="composer-images">
            {files.map((f, i) => (
              <span className="thumb" key={f.preview}>
                <img src={f.preview} alt={f.file.name} />
                <button
                  type="button"
                  aria-label={`Remove ${f.file.name}`}
                  onClick={() => {
                    URL.revokeObjectURL(f.preview)
                    setFiles((all) => all.filter((_, j) => j !== i))
                  }}
                >
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="composer-row">
          <textarea
            ref={input}
            rows={1}
            value={text}
            disabled={busy}
            placeholder={placeholder}
            aria-label="Question"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                send(text)
              }
            }}
            onPaste={(e) => e.clipboardData.files.length && addFiles(e.clipboardData.files)}
          />
          {!busy && (
            <>
              <input
                ref={picker}
                type="file"
                accept={IMAGE_TYPES.join(',')}
                multiple
                hidden
                onChange={(e) => {
                  addFiles(e.target.files)
                  e.target.value = ''
                }}
              />
              <button
                type="button"
                className="icon-button attach"
                aria-label="Attach images"
                title="Attach images"
                onClick={() => picker.current?.click()}
              >
                <ImagePlus size={18} strokeWidth={1.6} />
              </button>
            </>
          )}
          {busy ? (
            <button type="submit" className="send is-stop" aria-label="Stop" title="Stop both answers" disabled={!canStop}>
              <Square size={12} fill="currentColor" strokeWidth={0} />
            </button>
          ) : (
            <button type="submit" className={`send ${ready ? 'is-ready' : ''}`} aria-label="Send" disabled={!ready}>
              <ArrowUp size={17} strokeWidth={2.2} />
            </button>
          )}
        </div>
      </form>
    </div>
  )
}
