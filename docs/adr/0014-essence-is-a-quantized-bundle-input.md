# Essence is derived per Town, quantized, and an input to every Bundle

**Essence** summarises the character of a Town from its resolved Facts: the median and 90th-percentile building height, the mix of roof shapes, the most common wall colours, and the mix of props. Generators use it only where they would otherwise imagine, so an unseen building in Zürich comes out Zürich-like rather than generic. Imagined values keep `IMAGINED` confidence and still render soft.

Essence is a pure function of Facts (invariant 1). It is part of every Bundle's inputs and so of its content address. To stop each new Fact from changing a whole Town's Bundles, Essence is **quantized**: heights to 0.5 m, roof-shape weights to 0.05, the palette to its 8 most common colours, counts to buckets (5, 10, 25, 50, 100, …), and nothing at all until a Town has 5 known samples. Postcards snapshot the Essence of their Towns, so they still rebuild byte-identical.

## Consequences

- When a Town's Essence does change, all of its Cells rebuild lazily on their next request.
- `pick` weights may now be expressions, so generators can weight choices by Essence. This changes the DSL and the interpreter version.
