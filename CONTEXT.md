# Otherhere

A second version of where you already are: your real place, but playable, imagined, and shared. Every person's **World** starts as a stylized sketch of the whole Earth and sharpens wherever they play, capture, or pay attention. A game first, not a digital twin.

## Language

### Place and space

**Cell**:
An H3 resolution-9 cell; the unit of loading, generation, and caching (ADR-0001).
_Avoid_: tile, chunk, hex

**Town**:
An H3 resolution-6 cell; the partition owned by one `TownDO` (ADR-0002).
_Avoid_: region, shard, zone

**Anchor cell**:
The single **Cell** a **Feature** belongs to, decided by its centroid or midpoint (ADR-0003).

### Knowledge

**World**:
A person's remembered world: **Facts**, **Captures**, **Essence**, and **Memories**.

**Feature**:
A building, road segment, tree, prop, or other thing in the world, with a stable source-namespaced ID such as `osm:w123`.
_Avoid_: object, entity, element

**Fact**:
One attribute of one **Feature**, with provenance (source, confidence, observedAt, version).
_Avoid_: tag, property, datum

**Source**:
Where a **Fact** came from, ranked `osm` < `overture` < `satellite_inference` < `street_imagery` < `capture` < `manual_edit`.

**Resolved value**:
The winning **Fact** for one (Feature, attribute), chosen by source rank, then confidence, then time (ADR-0004).

**Capture**:
User-recorded media (video, GPS track, photos, voice notes) attached to a place.

**Essence**:
Compressed statistics of a neighborhood's character, used to imagine unseen areas.

**Memory**:
A high-salience place kept at full fidelity forever.

### Making

**Generator**:
A parametric object definition (a **GeneratorDef**, JSON) run by our trusted interpreter (ADR-0005).
_Avoid_: script, template, prefab

**Bundle**:
The derived, content-addressed, always-regenerable assets (a GLB) for one **Cell** (ADR-0007).
_Avoid_: tile, asset pack

### Play and sharing

**Ruleset**:
The game being played: objectives, simulation, and fog behaviour.

**Capsule**:
A shareable package (a place, capture, ruleset, or match) that snapshots its Facts and carries a **Scope** (ADR-0008).

**Scope**:
Who may see something: `private` | `friends` | `public`.

### Intelligence and compute

**Plugin**:
An optional device that contributes compute (GPU laptop, always-on server, any laptop, phone).

**Question pack**:
A versioned set of typed questions answered by a decision model.

**Ladder**:
The escalation path for decisions: rule → distilled model → Jev → Groq → Claude → human quest.

**Rung**:
One step of the **Ladder**.

## Relationships

- A **World** holds many **Facts**; each **Fact** describes exactly one **Feature**.
- A **Feature** has exactly one **Anchor cell**; a **Cell** has many **Features**.
- A **Town** contains 7⁴ ≈ 2,401 **Cells**; a **Cell** belongs to exactly one **Town**.
- A **Bundle** is a pure function of one **Cell**'s **Resolved values** and the **Generator** versions used.
- A **Capsule** snapshots the **Facts** it needs and never ships a **Bundle**.

## Example dialogue

> **Dev:** "The user walked into a new **Cell**. Do we generate its **Bundle** right away?"
> **Domain expert:** "Only if its **Town** has no current **Bundle** hash for that **Cell**. Otherwise we serve the cached GLB, since the **Resolved values** haven't changed."
> **Dev:** "And if a **Capture** later says the roof is gable, not flat?"
> **Domain expert:** "That's a new **Fact** with source `capture`. It outranks `osm`, the **Resolved value** changes, so the hash changes and a new **Bundle** is built."

## Flagged ambiguities

- "**otherhere**" is the product name and also what people call a place they made or play in ("Tokyo's otherhere"). It is a UI/marketing word, not a code term. In code, a made thing is a **Capsule** and a person's version of a place is part of their **World**.
- "tile" was used loosely for both **Cell** and **Bundle**. Resolved: avoid "tile" entirely.
