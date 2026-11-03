import { Popup, type ExpressionSpecification, type GeoJSONSource } from 'maplibre-gl'
import { useEffect, useRef } from 'react'

import { Alert } from '@/components/ui/display'
import { INK } from '@/features/analytics/chartTheme'
import type { Schemas } from '@/lib/api/client'

import { boundsOf } from './geo'
import { useMapLibre } from './useMapLibre'

type FarmPoint = Schemas['FarmPoint']
type Collection = Parameters<GeoJSONSource['setData']>[0]

const EMPTY: Collection = { type: 'FeatureCollection', features: [] }

function pointsCollection(points: FarmPoint[]): Collection {
  return {
    type: 'FeatureCollection',
    features: points.map((p) => ({
      type: 'Feature',
      // Only the id: details are looked up from React state when a point is chosen.
      properties: { id: p.id },
      geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
    })),
  }
}

export function ChoroplethMap({
  config,
  areas,
  fill,
  describeArea,
  points,
  onAreaClick,
  onPointClick,
}: {
  config: Schemas['MapConfig']
  areas: Schemas['BoundaryCollection'] | undefined
  fill: unknown
  describeArea: (id: string, name: string) => string
  points: FarmPoint[]
  onAreaClick: (id: string) => void
  onPointClick: (id: string) => void
}) {
  const container = useRef<HTMLDivElement>(null)
  const { map, failed } = useMapLibre(container, config)
  const handlers = useRef({ describeArea, onAreaClick, onPointClick })
  useEffect(() => {
    handlers.current = { describeArea, onAreaClick, onPointClick }
  })

  // Layers and pointer events, once per map.
  useEffect(() => {
    if (!map) return
    map.addSource('areas', { type: 'geojson', data: EMPTY })
    map.addLayer({
      id: 'areas-fill',
      type: 'fill',
      source: 'areas',
      paint: { 'fill-color': 'rgba(0,0,0,0)', 'fill-opacity': 0.8 },
    })
    map.addLayer({
      id: 'areas-line',
      type: 'line',
      source: 'areas',
      paint: { 'line-color': INK.surface, 'line-width': 1.5 },
    })
    map.addLayer({
      id: 'areas-outline',
      type: 'line',
      source: 'areas',
      paint: { 'line-color': INK.secondary, 'line-width': 0.5 },
    })
    map.addSource('farms', {
      type: 'geojson',
      data: EMPTY,
      cluster: true,
      clusterRadius: 40,
      clusterMaxZoom: 15,
    })
    map.addLayer({
      id: 'farm-clusters',
      type: 'circle',
      source: 'farms',
      filter: ['has', 'point_count'],
      paint: {
        'circle-color': INK.primary,
        'circle-radius': ['step', ['get', 'point_count'], 10, 10, 14, 50, 18],
        'circle-stroke-color': INK.surface,
        'circle-stroke-width': 2,
      },
    })
    map.addLayer({
      id: 'farm-points',
      type: 'circle',
      source: 'farms',
      filter: ['!', ['has', 'point_count']],
      paint: {
        'circle-color': INK.primary,
        'circle-radius': 5,
        'circle-stroke-color': INK.surface,
        'circle-stroke-width': 2,
      },
    })

    const popup = new Popup({ closeButton: false, closeOnClick: false })
    const hide = () => {
      map.getCanvas().style.cursor = ''
      popup.remove()
    }
    // setText, never HTML: names come from data files.
    map.on('mousemove', 'areas-fill', (e) => {
      const props = e.features?.[0]?.properties as { id: string; name: string } | undefined
      if (!props) return
      map.getCanvas().style.cursor = 'pointer'
      popup
        .setLngLat(e.lngLat)
        .setText(handlers.current.describeArea(props.id, props.name))
        .addTo(map)
    })
    map.on('mouseleave', 'areas-fill', hide)
    map.on('mouseenter', 'farm-clusters', (e) => {
      const size = (e.features?.[0]?.properties as { point_count?: number } | undefined)
        ?.point_count
      map.getCanvas().style.cursor = 'pointer'
      popup
        .setLngLat(e.lngLat)
        .setText(`${String(size ?? 0)} farms: click to zoom in`)
        .addTo(map)
    })
    map.on('mouseleave', 'farm-clusters', hide)
    map.on('mouseenter', 'farm-points', () => {
      popup.remove()
      map.getCanvas().style.cursor = 'pointer'
    })
    map.on('mouseleave', 'farm-points', hide)

    map.on('click', (e) => {
      popup.remove() // the view is about to change; the hover text would be left behind
      const hit = map.queryRenderedFeatures(e.point, {
        layers: ['farm-points', 'farm-clusters', 'areas-fill'],
      })[0]
      if (!hit) return
      if (hit.layer.id === 'farm-clusters') {
        const source = map.getSource<GeoJSONSource>('farms')
        const cluster = (hit.properties as { cluster_id: number }).cluster_id
        void source?.getClusterExpansionZoom(cluster).then((zoom) => {
          map.easeTo({ center: e.lngLat, zoom })
        })
      } else if (hit.layer.id === 'farm-points') {
        handlers.current.onPointClick((hit.properties as { id: string }).id)
      } else {
        handlers.current.onAreaClick((hit.properties as { id: string }).id)
      }
    })
  }, [map])

  useEffect(() => {
    void map?.getSource<GeoJSONSource>('areas')?.setData((areas ?? EMPTY) as unknown as Collection)
  }, [map, areas])

  useEffect(() => {
    map?.setPaintProperty('areas-fill', 'fill-color', fill as ExpressionSpecification)
  }, [map, fill])

  useEffect(() => {
    void map?.getSource<GeoJSONSource>('farms')?.setData(pointsCollection(points))
  }, [map, points])

  const lastFit = useRef('')
  useEffect(() => {
    if (!map) return
    const bounds = boundsOf(
      (areas?.features ?? []).map((f) => f.geometry),
      points,
    )
    const key = JSON.stringify(bounds)
    if (!bounds || key === lastFit.current) return
    lastFit.current = key
    map.fitBounds(
      [
        [bounds[0], bounds[1]],
        [bounds[2], bounds[3]],
      ],
      { padding: 32, maxZoom: 14, duration: 0 },
    )
  }, [map, areas, points])

  if (failed) {
    return (
      <Alert tone="warning">
        This browser cannot draw the map (WebGL is off). The figures are in the table below.
      </Alert>
    )
  }
  return (
    <div
      ref={container}
      role="region"
      aria-label="Map of areas and farm locations. The same figures are in the table below."
      className="h-[28rem] w-full overflow-hidden rounded-md border border-line"
    />
  )
}
