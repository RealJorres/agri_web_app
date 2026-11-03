import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { z } from 'zod'

import { App } from '@/app/App'
import '@/index.css'

// Our security policy forbids eval, so Zod should not try it to speed up validation.
z.config({ jitless: true })

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root element')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
