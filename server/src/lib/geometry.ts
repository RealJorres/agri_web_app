/** Checks on map shapes. A boundary file can hold rings with many thousands of points. */

type Position = readonly number[]

interface Segment {
  index: number
  ax: number
  ay: number
  bx: number
  by: number
  minX: number
  maxX: number
  minY: number
  maxY: number
}

function side(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return Math.sign((bx - ax) * (cy - ay) - (by - ay) * (cx - ax))
}

function within(a: number, b: number, value: number): boolean {
  return value >= Math.min(a, b) && value <= Math.max(a, b)
}

function intersect(s: Segment, t: Segment): boolean {
  const d1 = side(s.ax, s.ay, s.bx, s.by, t.ax, t.ay)
  const d2 = side(s.ax, s.ay, s.bx, s.by, t.bx, t.by)
  const d3 = side(t.ax, t.ay, t.bx, t.by, s.ax, s.ay)
  const d4 = side(t.ax, t.ay, t.bx, t.by, s.bx, s.by)
  if (d1 !== d2 && d3 !== d4) return true
  const onSegment = (seg: Segment, x: number, y: number) =>
    within(seg.ax, seg.bx, x) && within(seg.ay, seg.by, y)
  return (
    (d1 === 0 && onSegment(s, t.ax, t.ay)) ||
    (d2 === 0 && onSegment(s, t.bx, t.by)) ||
    (d3 === 0 && onSegment(t, s.ax, s.ay)) ||
    (d4 === 0 && onSegment(t, s.bx, s.by))
  )
}

/** A sweep across x, so only segments that overlap sideways are ever compared. */
function selfIntersects(ring: readonly Position[]): boolean {
  const segments: Segment[] = []
  for (let i = 0; i + 1 < ring.length; i += 1) {
    const [ax = 0, ay = 0] = ring[i] ?? []
    const [bx = 0, by = 0] = ring[i + 1] ?? []
    if (ax === bx && ay === by) continue // a repeated point, not a line
    segments.push({
      index: segments.length,
      ax,
      ay,
      bx,
      by,
      minX: Math.min(ax, bx),
      maxX: Math.max(ax, bx),
      minY: Math.min(ay, by),
      maxY: Math.max(ay, by),
    })
  }
  const count = segments.length
  const ordered = [...segments].sort((a, b) => a.minX - b.minX)
  let active: Segment[] = []
  for (const segment of ordered) {
    active = active.filter((other) => other.maxX >= segment.minX)
    for (const other of active) {
      const gap = Math.abs(segment.index - other.index)
      // Neighbours along the ring share a point, which is not a crossing.
      if (gap === 1 || gap === count - 1) continue
      if (segment.maxY < other.minY || segment.minY > other.maxY) continue
      if (intersect(segment, other)) return true
    }
    active.push(segment)
  }
  return false
}

/** A polygon ring is usable when it is closed, encloses an area, and never crosses itself. */
export function isValidRing(ring: readonly Position[]): boolean {
  const first = ring[0]
  const last = ring.at(-1)
  if (ring.length < 4 || !first || !last) return false
  if (first[0] !== last[0] || first[1] !== last[1]) return false
  return !selfIntersects(ring)
}
