import { z } from 'zod'

const accounts = z.array(
  z.object({
    role: z.string().min(1),
    email: z.email(),
    password: z.string().min(1),
  }),
)

export type DemoAccount = z.infer<typeof accounts>[number]

/**
 * Accounts to show on the sign-in page during a demo, from VITE_DEMO_ACCOUNTS at build time. Off unless
 * set, and never kept in git. Whatever is set here is public: see docs/deployment.md before adding any.
 */
export function parseDemoAccounts(raw: unknown): DemoAccount[] {
  if (typeof raw !== 'string' || raw.trim() === '') return []
  try {
    const parsed = accounts.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : []
  } catch {
    return []
  }
}
