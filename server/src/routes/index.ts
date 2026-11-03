import { Router } from 'express'

import { getHealth } from '../controllers/health.controller.js'

export const apiRouter = Router()

apiRouter.get('/health', getHealth)
