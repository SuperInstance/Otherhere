import { z } from 'zod';

/** Who may see something. Everything starts `private` (invariant 5). */
export const Scope = z.enum(['private', 'friends', 'public']);
export type Scope = z.infer<typeof Scope>;
