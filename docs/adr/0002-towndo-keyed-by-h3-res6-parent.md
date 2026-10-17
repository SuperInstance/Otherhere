# TownDO is keyed by the Cell's H3 resolution-6 parent

A **Town** is an H3 res-6 cell (~36 km², ~3.5 km edge). Every `TownDO` instance is addressed as `idFromName(cellToParent(cell, 6))`, so any Cell request routes to its Town with no lookup table. Res 6 is about one town or city district: big enough for **Essence** to mean something, small enough that a dense downtown is a few hundred thousand Fact rows in one SQLite-backed Durable Object. Res 5 (~250 km²) would make one single-threaded object hold all of Manhattan; res 7 (~5 km²) fragments Essence and makes a short walk touch several DOs.

## Consequences

- A walk near a Town border reads Cells from two DOs. That is fine because the client fetches per Cell.
- Features are anchored to exactly one Cell (ADR-0003), so they live in exactly one Town.
