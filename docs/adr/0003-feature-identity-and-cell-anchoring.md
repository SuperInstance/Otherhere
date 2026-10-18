# Feature identity and Cell anchoring

**Feature IDs** are namespaced by the source that first created them and never change: `osm:w123`, `osm:n456`, `osm:r789` for OSM ways/nodes/relations; later sources mint `cap:<uuid>` or `edit:<uuid>`. When a later source describes an existing Feature it writes Facts against the existing ID instead of minting a new one. We chose source-derived IDs over opaque UUIDs so re-ingesting OSM is idempotent without a mapping table.

Each Feature is **anchored** to the single Cell that contains its footprint centroid (area features) or its node (point features). A Cell's Bundle contains exactly its anchored Features, even if their geometry crosses the Cell border. Linear features (roads) are split at ingest into node-to-node segments, and each segment is anchored to the Cell containing its midpoint. This needs no polygon clipping, and every segment appears in exactly one Bundle.

## Considered Options

- Clipping geometry to hexagon boundaries: rejected. It produces visible seams and costs more for no gameplay benefit.
