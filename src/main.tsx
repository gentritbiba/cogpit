import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { DeviceRoot } from './components/DeviceRoot.tsx'
import { SharedRoot } from './components/SharedSession/SharedRoot.tsx'
import { AppErrorBoundary } from './components/AppErrorBoundary.tsx'
import { isSharedPath } from './lib/sharePath.ts'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Root element not found')

// Branched at the root, not inside App: a guest must never mount the login
// gate, the setup gate, device switching, the sidebar or the command palette,
// and the only way to guarantee that is for them not to be in the tree.
createRoot(rootEl).render(
  <StrictMode>
    <AppErrorBoundary>
      {isSharedPath(window.location.pathname) ? <SharedRoot /> : <DeviceRoot />}
    </AppErrorBoundary>
  </StrictMode>,
)
