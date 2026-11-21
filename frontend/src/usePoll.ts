import { useCallback, useEffect, useRef, useState } from 'react'

/** Runs `fn` now and every `ms`; returns a manual refresh. */
export function usePoll(fn: () => Promise<void>, ms = 2000): () => void {
  const ref = useRef(fn)
  ref.current = fn
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let live = true
    const run = () => { if (live) void ref.current() }
    run()
    const t = setInterval(run, ms)
    return () => { live = false; clearInterval(t) }
  }, [ms, tick])
  return useCallback(() => setTick((n) => n + 1), [])
}
