# Until accounts exist, postcard Scope is enforced by possession of a link

Postcards are saved as Capsule JSON in R2 under an unguessable ID (`pc_` + 10 random characters, about 50 bits). With no accounts yet (ADR-0009), Scope is enforced by what the viewer holds:

- `private` postcards also need the owner key returned once at save time, and without it they answer exactly like a missing postcard;
- `friends` postcards need the link;
- `public` postcards are the same link, cacheable, and eligible for a future directory.

This is the minimum that keeps invariant 5's "private by default" meaningful before accounts. When friend auth lands (M1+), `friends` becomes a real check, and the possession rule remains as the fallback for links shared outside the app.

## Consequences

- A leaked `friends` link is readable by anyone who has it. The UI says "Anyone with the link".
- Place postcards contain only map Facts, so `privacy.blurred` is vacuously true. Captures will have to be blurred by the agent before they can be attached.
- Location fuzzing for home areas is not implemented yet: a postcard reveals the true coordinates of its Cells.
