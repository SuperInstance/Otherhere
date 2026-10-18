# Sessions: the SessionDO owns game events; motion goes peer-to-peer

A match is a `SessionDO` addressed by a short join code (no accounts, ADR-0009). Clients connect to it over a hibernatable WebSocket. It assigns teams, relays WebRTC signaling, and is the **single authority for game events**: flag pickups, captures, tags, score, and the clock. It decides them by running the pure Ruleset logic in `packages/core/src/game` over the positions clients report (~5 Hz).

Smooth motion travels **peer-to-peer** over unreliable, unordered WebRTC data channels (~20 Hz). The WebSocket also relays positions, so a pair that cannot connect directly still sees each other, only less smoothly. ICE uses Cloudflare's STUN, plus Cloudflare Realtime TURN credentials when the deployment has a TURN key configured.

## Considered Options

- Fully peer-to-peer game state (a host client): rejected. A host that leaves ends the match, and two clients that disagree about a capture have no tiebreak.
- All motion through the DO: rejected as the only path. It is the fallback, but it adds a hop of latency and costs DO requests at 20 Hz × players.

## Consequences

- Fog is applied by each client from the shared state (`visibleTo`). Anti-cheat is a non-goal, so a modified client could see through fog.
- Positions are in the session's world frame: metres east/south of the session's origin Cell centre, the same frame the client renders in.
