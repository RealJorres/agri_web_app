import { z } from 'zod'

export const loginBody = z.object({
  email: z.string().trim().pipe(z.email()),
  password: z.string().min(1),
})
