# ADR-0016: Maps — boundaries only from official data; tile source
Status: Proposed · 2026-10-27

**Decision.** Boundaries are loaded only from a file the PAO supplies (NAMRIA/PSA), like PSGC
(ADR-0005); without it the map shows farm points and tabular figures, never approximated shapes.
The map uses MapLibre GL with a configurable tile URL (`MAP_TILE_URL`), defaulting to OpenStreetMap
raster tiles with attribution for low-volume internal use; switch to a hosted provider or self-hosted
tiles before public use (Phase 3 public dashboard). Farm points are personal data: only for roles with
`view_personal_data`, and coordinates are never put in URLs.
