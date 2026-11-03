import { Map as MapLibreMap, NavigationControl, setWorkerUrl } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import { useEffect, useRef, useState, type RefObject } from 'react'

import type { Schemas } from '@/lib/api/client'

type MapConfig = Schemas['MapConfig']

// MapLibre computes its default worker URL at runtime, so bundlers neither emit nor rewrite it: the
// base tiles would draw, but every GeoJSON layer (areas, farm points) would silently stay empty.
setWorkerUrl(workerUrl)

/** Creates the map once the container exists; null until it has loaded. `failed` means no WebGL. */
export function useMapLibre(
  container: RefObject<HTMLDivElement | null>,
  config: MapConfig,
): { map: MapLibreMap | null; failed: boolean } {
  const [map, setMap] = useState<MapLibreMap | null>(null)
  const [failed, setFailed] = useState(false)
  const started = useRef(false)

  useEffect(() => {
    if (!container.current || started.current) return
    started.current = true
    let instance: MapLibreMap
    try {
      instance = new MapLibreMap({
        container: container.current,
        style: {
          version: 8,
          sources: {
            base: {
              type: 'raster',
              tiles: [config.tile_url],
              tileSize: 256,
              attribution: config.tile_attribution,
            },
          },
          layers: [{ id: 'base', type: 'raster', source: 'base' }],
        },
        center: [config.center[0] ?? 0, config.center[1] ?? 0],
        zoom: config.zoom,
        dragRotate: false,
        pitchWithRotate: false,
      })
    } catch {
      queueMicrotask(() => setFailed(true))
      started.current = false
      return
    }
    instance.addControl(new NavigationControl({ showCompass: false }))
    instance.on('load', () => {
      instance.resize()
      setMap(instance)
    })
    return () => {
      started.current = false
      setMap(null)
      instance.remove()
    }
  }, [container, config.tile_url, config.tile_attribution, config.center, config.zoom])

  return { map, failed }
}
