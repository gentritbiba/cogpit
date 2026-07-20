import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { DeviceRoot } from './components/DeviceRoot.tsx'
import { AppErrorBoundary } from './components/AppErrorBoundary.tsx'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Root element not found')

createRoot(rootEl).render(
  <StrictMode>
    <AppErrorBoundary>
      <DeviceRoot />
    </AppErrorBoundary>
  </StrictMode>,
)
