/** In-process background work (ADR-0019): the job's own document records its progress. */
import { logger, safeErrorDetails } from './logger.js'

const running = new Set<Promise<void>>()

export function runInBackground(name: string, task: () => Promise<unknown>): void {
  const tracked: Promise<void> = task()
    .then(() => undefined)
    .catch((error: unknown) => {
      logger.error('background.failed', { task: name, ...safeErrorDetails(error) })
    })
    .finally(() => {
      running.delete(tracked)
    })
  running.add(tracked)
}

/** Waits for work in progress, for a clean shutdown and for tests. */
export async function settleBackgroundTasks(): Promise<void> {
  while (running.size > 0) await Promise.all(running)
}
