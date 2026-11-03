/**
 * Writes Netlify's routing into the built site, from API_ORIGIN (the Render address). Forwarding /api
 * keeps the browser on one origin, so the sign-in cookie works and no CORS is needed (ADR-0023).
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const origin = process.env.API_ORIGIN ?? ''
if (!/^https:\/\/[^/\s]+$/u.test(origin)) {
  console.error('Set API_ORIGIN to the API address, such as https://agri-dms-api.onrender.com')
  process.exit(1)
}
const rules = [`/api/* ${origin}/api/:splat 200`, '/* /index.html 200', '']
writeFileSync(join(import.meta.dirname, '..', 'dist', '_redirects'), rules.join('\n'))
console.log('Wrote the proxy rules.')
