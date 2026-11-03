import { Marker, type MapMouseEvent } from 'maplibre-gl'
import { LocateFixed } from 'lucide-react'
import { useEffect, useRef, useState, type SyntheticEvent } from 'react'

import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Alert } from '@/components/ui/display'
import { TextInput } from '@/components/ui/fields'
import { LoadingBlock } from '@/components/ui/Spinner'
import { useToast } from '@/components/ui/useToast'
import type { Schemas } from '@/lib/api/client'
import { errorMessage } from '@/lib/forms'

import { useMapConfig, useSetFarmLocation } from './api'
import { locationSchema, type LonLat } from './geo'
import { useMapLibre } from './useMapLibre'

/** Set or clear one farm's location: click the map, use the device GPS, or type the numbers. */
export default function FarmLocationDialog({
  farmerId,
  farmId,
  farmLabel,
  current,
  onClose,
}: {
  farmerId: string
  farmId: string
  farmLabel: string
  current: LonLat | null
  onClose: () => void
}) {
  const notify = useToast()
  const config = useMapConfig()
  const save = useSetFarmLocation(farmerId)
  const [lon, setLon] = useState(current ? String(current.lon) : '')
  const [lat, setLat] = useState(current ? String(current.lat) : '')
  const [problem, setProblem] = useState<string | null>(null)
  const [locating, setLocating] = useState(false)
  const [accuracy, setAccuracy] = useState<number | null>(null)

  const parsed = locationSchema.safeParse({ lon: lon || undefined, lat: lat || undefined })
  const pin = parsed.success ? parsed.data : null

  const place = (next: LonLat) => {
    setLon(next.lon.toFixed(6))
    setLat(next.lat.toFixed(6))
    setAccuracy(null)
    setProblem(null)
  }

  const locateDevice = () => {
    if (!('geolocation' in navigator)) {
      setProblem('This device cannot share its location. Click the map instead.')
      return
    }
    setLocating(true)
    setProblem(null)
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocating(false)
        place({ lon: position.coords.longitude, lat: position.coords.latitude })
        setAccuracy(Math.round(position.coords.accuracy))
      },
      (error) => {
        setLocating(false)
        setProblem(
          error.code === error.PERMISSION_DENIED
            ? 'Location permission was refused. Allow it in the browser, or click the map.'
            : 'Could not get a GPS fix. Try again outdoors, or click the map.',
        )
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
    )
  }

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault()
    if (!parsed.success) {
      setProblem(parsed.error.issues[0]?.message ?? 'Enter a valid location.')
      return
    }
    try {
      await save.mutateAsync({ farm: farmId, location: parsed.data })
      notify('Farm location saved.')
      onClose()
    } catch (err) {
      setProblem(errorMessage(err))
    }
  }

  const clear = async () => {
    try {
      await save.mutateAsync({ farm: farmId, location: null })
      notify('Farm location removed.')
      onClose()
    } catch (err) {
      setProblem(errorMessage(err))
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Farm location: ${farmLabel}`}
      footer={
        <>
          {current ? (
            <Button variant="secondary" onClick={() => void clear()} disabled={save.isPending}>
              Remove location
            </Button>
          ) : null}
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="farm-location" loading={save.isPending}>
            Save location
          </Button>
        </>
      }
    >
      <form id="farm-location" className="space-y-3" onSubmit={(e) => void submit(e)}>
        {problem ? <Alert tone="error">{problem}</Alert> : null}
        <p className="text-sm text-muted">
          Click the map where the farm is, or use this device&apos;s GPS while standing on the farm.
        </p>
        {config.isPending ? (
          <LoadingBlock />
        ) : config.data ? (
          <PickerMap config={config.data} start={current} pin={pin} onPick={place} />
        ) : (
          <Alert tone="warning">The map could not be loaded. You can type the numbers below.</Alert>
        )}
        <Button variant="secondary" onClick={locateDevice} loading={locating}>
          <LocateFixed className="h-4 w-4" aria-hidden="true" />
          Use my location
        </Button>
        {accuracy !== null ? (
          <p className="text-xs text-muted" role="status">
            GPS accuracy: about {accuracy} m.
          </p>
        ) : null}
        <div className="grid grid-cols-2 gap-3">
          <TextInput
            label="Latitude"
            inputMode="decimal"
            value={lat}
            onChange={(e) => setLat(e.target.value)}
          />
          <TextInput
            label="Longitude"
            inputMode="decimal"
            value={lon}
            onChange={(e) => setLon(e.target.value)}
          />
        </div>
      </form>
    </Dialog>
  )
}

function PickerMap({
  config,
  start,
  pin,
  onPick,
}: {
  config: Schemas['MapConfig']
  start: LonLat | null
  pin: LonLat | null
  onPick: (next: LonLat) => void
}) {
  const container = useRef<HTMLDivElement>(null)
  const { map, failed } = useMapLibre(container, config)
  const marker = useRef<Marker | null>(null)
  const pick = useRef(onPick)
  useEffect(() => {
    pick.current = onPick
  })

  useEffect(() => {
    if (!map) return
    const onClick = (e: MapMouseEvent) => {
      pick.current({ lon: e.lngLat.lng, lat: e.lngLat.lat })
    }
    map.on('click', onClick)
    map.getCanvas().style.cursor = 'crosshair'
    return () => {
      map.off('click', onClick)
    }
  }, [map])

  useEffect(() => {
    if (map && start) map.jumpTo({ center: [start.lon, start.lat], zoom: 15 })
  }, [map, start])

  useEffect(() => {
    if (!map) return
    if (!pin) {
      marker.current?.remove()
      marker.current = null
      return
    }
    if (!marker.current) marker.current = new Marker().setLngLat(pin).addTo(map)
    else marker.current.setLngLat(pin)
    if (!map.getBounds().contains(pin)) map.easeTo({ center: [pin.lon, pin.lat] })
  }, [map, pin?.lon, pin?.lat]) // eslint-disable-line react-hooks/exhaustive-deps -- pin is rebuilt each render

  if (failed) {
    return (
      <Alert tone="warning">
        This browser cannot draw the map (WebGL is off). Use GPS or type the numbers below.
      </Alert>
    )
  }
  return (
    <div
      ref={container}
      role="region"
      aria-label="Map for choosing the farm's location. You can also type the numbers below."
      className="h-72 w-full overflow-hidden rounded-md border border-line"
    />
  )
}
