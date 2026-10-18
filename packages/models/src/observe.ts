import { BUILDING_PACK, buildingFacts, type Fact, type Source } from '@otherhere/core';
import type { ChatProvider } from './providers/chat';
import type { Ladder, LadderResult } from './ladder';

export const VISION_PROMPT =
  'This photo was taken at street level. Look only at the single building nearest the centre of the image. ' +
  'Describe its exterior factually in a few plain sentences: roof shape and roof colour, number of above-ground floors, and main wall colour and material. ' +
  'If you cannot see a single building clearly, say so. Do not guess about anything that is not visible.';

export type Observation = {
  observation: string;
  visionCostUsd: number;
  result: LadderResult;
  facts: Fact[];
};

/**
 * Pixels → words → typed answers → Facts. The photo itself is never stored:
 * only the observation text (in the decision log) and the Facts survive.
 */
export async function observeBuilding(
  input: { jpegBase64: string; featureId: string; source: Source; observedAt: string },
  deps: { vision: ChatProvider; ladder: Ladder },
): Promise<Observation> {
  const seen = await deps.vision.describe(input.jpegBase64, VISION_PROMPT);
  const result = await deps.ladder.decide({
    pack: BUILDING_PACK,
    state: seen.value,
    subject: input.featureId,
  });
  const facts = result?.accepted ? buildingFacts(result.decision.answers, input) : [];
  return { observation: seen.value, visionCostUsd: seen.costUsd, result, facts };
}
