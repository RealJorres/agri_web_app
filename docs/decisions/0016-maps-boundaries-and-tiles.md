# ADR-0016: Maps — boundaries only from official data; tile source
Status: Proposed · 2026-10-27, implementation details added 2026-11-03 (P2-M5)

**Decision.** Boundaries are loaded only from a file the PAO supplies (NAMRIA/PSA), like PSGC
(ADR-0005); without it the map shows farm points and tabular figures, never approximated shapes.
The map uses MapLibre GL with a configurable tile URL (`MAP_TILE_URL`), defaulting to OpenStreetMap
raster tiles with attribution for low-volume internal use; switch to a hosted provider or self-hosted
tiles before public use (Phase 3 public dashboard). Farm points are personal data: only for roles with
`view_personal_data`, and coordinates are never put in URLs.

**Loader (`seed_boundaries`).** A feature is applied only when it ties to one location without
guessing:
- by PSGC code first, otherwise by name within `--province` (barangays also by municipality);
- repeated rows of one area merge (islands), but only when a code or province attribute shows they
  are the same place: a national file with no province attribute can hold another "Santa Cruz", so
  those are reported as ambiguous and left unloaded;
- shapes are converted to WGS84 and refused if they fall outside the Philippines (this also catches
  swapped axes and a wrong coordinate system); a shapefile with no `.prj` is refused;
- nothing that fails these checks is drawn; it is listed for a person to resolve. `--dry-run` shows
  the report first. Attribute names are auto-detected for the common sources and can be overridden.
  The real PAO file has not been seen yet, so the detection list may need extending.

**Scoping.** Boundaries are public geography, so they are reference data like the municipality list
and are not scoped. Every figure drawn on them comes from the scoped analytics breakdown, so an area
outside the caller's assignment appears with an outline and no colour.

**Privacy of tile requests.** A tile request tells the tile server which area is being viewed. The
default OSM server therefore learns the rough area around any farm a user zooms to, though nothing
identifies the farm or farmer. This is accepted for low-volume internal use and is another reason to
move to self-hosted tiles before wider use.

**Deployment.** Pages send `Referrer-Policy: strict-origin-when-cross-origin`, because OpenStreetMap refuses
tile requests with no referrer. Only the site address is sent, never a path or record id. The web server's CSP for the SPA must allow the tile host in `img-src` and
`connect-src`, and `'self'` in `worker-src` (MapLibre loads its worker from the built files). Device GPS needs
HTTPS outside localhost.

**On MongoDB (ADR-0019).** The loader is `npm run seed-boundaries -w server`. Shapes are stored as
GeoJSON. A self-intersecting ring is reported, not repaired, so it needs fixing in the source file. A
GeoJSON file must be in WGS84 or UTM; any other coordinate system is refused rather than guessed, and a
shapefile's system comes from its `.prj`. No `2dsphere` index exists yet, because no query searches by
location: add one when a query needs it.

**Cluster labels.** Clusters show their size by radius, with the count in a hover popup. Text labels
on the map would need a glyph server, another external dependency.
