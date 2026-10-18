import { z } from 'zod';
import { isCell } from '../geo/h3';

export const CellId = z.string().refine(isCell, 'not an H3 res-9 Cell');
export type CellId = z.infer<typeof CellId>;
