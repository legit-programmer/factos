import '@fontsource-variable/instrument-sans'
import '@fontsource-variable/newsreader'
import '@fontsource-variable/newsreader/wght-italic.css'
import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { setTransport } from './api/client'
import { DEV_TOOLS, mockEnabled } from './dev/flags'
import './styles.css'

const DevTools = DEV_TOOLS ? lazy(() => import('./dev/DevTools')) : null

async function boot() {
  if (mockEnabled()) {
    // Swap the network layer before the first request (the session check) goes out.
    const mock = await import('./dev/mock/server')
    mock.startMock()
    setTransport(mock.mockFetch)
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
      {DevTools && (
        <Suspense fallback={null}>
          <DevTools />
        </Suspense>
      )}
    </StrictMode>,
  )
}

boot()
