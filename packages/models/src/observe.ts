import {
  BUILDING_PACK,
  buildingFacts,
  type Answers,
  type Fact,
  type QuestionPack,
  type Source,
} from '@otherhere/core';
import type { ChatProvider } from './providers/chat';
import { JevRejected, type JevProvider } from './providers/jev';
import type { Ladder, LadderResult } from './ladder';

export const VISION_PROMPT =
  'This photo was taken at street level. Look only at the single building nearest the centre of the image. ' +
  'Describe its exterior factually in a few plain sentences: roof shape and roof colour, number of above-ground floors, and main wall colour and material. ' +
  'If you cannot see a single building clearly, say so. Do not guess about anything that is not visible.';

/** Only the `visible` question, asked of the photo itself (the visibility gate). */
export const VISIBLE_PACK: QuestionPack = {
  ...BUILDING_PACK,
  id: 'pack.building.visible',
  questions: { visible: BUILDING_PACK.questions.visible! },
};

/** What the visibility gate saw: Jev's own P(one building), or why it could not say. */
export type Gate =
  { noul: number; costUsd: number } | { skipped: 'no gate' | 'refused' | 'error'; detail?: string };

/**
 * Below this P(one building) from the gate, the vision call and the Ladder are skipped:
 * nothing could become a Fact anyway. On our photo sets every photo of a building scored
 * at least 0.49 and every photo without one at most 0.34.
 */
export const SKIP_BELOW = 0.25;

export type Observation = {
  observation: string;
  visionCostUsd: number;
  result: LadderResult;
  gate: Gate;
  facts: Fact[];
};

/**
 * Pixels → words → typed answers → Facts. The photo itself is never stored:
 * only the observation text (in the decision log) and the Facts survive.
 *
 * With a `gate`, Jev also reads the photo directly, but only to decide whether it
 * shows one building. A vision model told to describe "the building nearest the
 * centre" always finds one, even in a skyline or an interior; Jev reading the
 * pixels does not. Its answer replaces the observation's `visible` when Facts are
 * made (docs/notes/model-field-notes.md, round 3). If the gate cannot answer, the
 * observation's own `visible` is used, as before.
 */
export async function observeBuilding(
  input: { jpegBase64: string; featureId: string; source: Source; observedAt: string },
  deps: { vision: ChatProvider; ladder: Ladder; gate?: JevProvider },
): Promise<Observation> {
  // Jev answers first (≈$0.00004, well under a second); a sure "no building" saves the
  // vision call (≈25× the cost) and the Ladder.
  const gate = await visibilityGate(deps.gate, input.jpegBase64);
  if ('noul' in gate && gate.noul < SKIP_BELOW)
    return { observation: '', visionCostUsd: 0, result: null, gate, facts: [] };
  const seen = await deps.vision.describe(input.jpegBase64, VISION_PROMPT);
  const result = await deps.ladder.decide({
    pack: BUILDING_PACK,
    state: seen.value,
    subject: input.featureId,
  });
  // Each field is gated on its own confidence (buildingFacts), so a shaky floor count
  // does not throw away a confident roof. The Ladder still escalates on the pack's
  // weakest answer, and returns its most confident answer when no rung clears the bar.
  let answers: Answers | null = result?.decision.answers ?? null;
  if (answers && 'noul' in gate)
    answers = { ...answers, visible: { type: 'noul', noul: gate.noul } };
  const facts = answers ? buildingFacts(answers, input) : [];
  return { observation: seen.value, visionCostUsd: seen.costUsd, result, gate, facts };
}

async function visibilityGate(jev: JevProvider | undefined, jpegBase64: string): Promise<Gate> {
  if (!jev) return { skipped: 'no gate' };
  try {
    const r = await jev.askAboutImage(VISIBLE_PACK, jpegBase64, VISION_PROMPT);
    const v = r.value.visible;
    return v?.type === 'noul' ? { noul: v.noul, costUsd: r.costUsd } : { skipped: 'error' };
  } catch (err) {
    const refused = err instanceof JevRejected;
    return { skipped: refused ? 'refused' : 'error', detail: (err as Error).message.slice(0, 200) };
  }
}
