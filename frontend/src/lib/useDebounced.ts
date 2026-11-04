import { useEffect, useState } from 'react'

/** Debounce a value so search requests are not sent on every keystroke. */
export function useDebounced<T>(value: T, ms = 350): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const handle = window.setTimeout(() => {
      setDebounced(value)
    }, ms)
    return () => {
      window.clearTimeout(handle)
    }
  }, [value, ms])
  return debounced
}
