/** The shapefile package ships no types. This covers the one function used. */
declare module 'shapefile' {
  export function read(
    shp: string,
    dbf?: string,
  ): Promise<{
    type: 'FeatureCollection'
    features: {
      type: 'Feature'
      properties: Record<string, unknown> | null
      geometry: { type: string; coordinates: unknown } | null
    }[]
  }>
}
