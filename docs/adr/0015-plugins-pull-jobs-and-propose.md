# Plugins pull leased jobs and return proposals; the TownDO derives Facts itself

A **Plugin** is an optional device (a home server, a GPU laptop, any laptop) that adds compute or network reach. Everything still works without one (invariant 7).

- **Pull, not push.** A Plugin sends its capability manifest (network, GPU and VRAM, CPU cores, always-on) to `POST /api/agent/claim` and gets back the oldest queued job it can run, or nothing. Devices behind home NATs need no inbound ports, and the edge never waits on a device that went to sleep.
- **Leases.** A claim holds a job for 5 minutes. A result after that, or from a device that does not hold the lease, is refused. A device that cannot finish simply goes quiet and the job is handed out again. After 3 claims without an accepted result the job is marked `failed`.
- **One queue.** `JobsDO` is a single Durable Object holding every job. Job IDs are `<kind>:<block>`, so queueing is idempotent. Traffic is a few requests per block, far below one object's limits. Cloudflare Queues would push to consumers, which does not fit devices that pull.
- **Results are proposals.** A Plugin never writes Facts. For `ingest_block` it returns the raw Overpass response. The TownDO checks that the block is in its Town, validates the response's shape, and runs the same trusted `osmToFacts` it uses for its own fetches. That keeps only Features anchored inside the block and always writes `source: "osm"`, so a Plugin cannot pick a source rank, reach outside its block, or smuggle in Facts. The block records which Plugin delivered it (`via: agent:<name>`).
- **Auth.** Plugins use `AGENT_TOKEN`; the owner's `/api/ops/crawl` and `/api/ops/jobs` use `OPS_TOKEN` (ADR-0009, single owner). Without a token those routes do not exist.

The first job kind is `ingest_block`. It serves both a crawler that pre-ingests blocks around a point and the TownDO itself: when its own Overpass fetch fails and Plugins are set up, it queues the block for one.

## Consequences

- A Plugin with the token could send a fabricated Overpass response for a block it was given. The token is the owner's, so this is trusted at the level of the owner's own devices. Proposals from other people's devices would need corroboration (two Plugins agreeing, or a spot check against Overpass) before they could be accepted.
- New job kinds (frame extraction and blurring on a GPU, distilled Ladder rungs) add a `Proposal` variant and a TownDO validator. A Plugin still returns evidence, never Facts.
