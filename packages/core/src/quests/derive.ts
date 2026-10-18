import type { ResolvedAttrs } from '../facts/resolve';
import { fnv1a32 } from '../hash/fnv';

/** What a photo of a building can fill in (the building question pack's attributes). */
export const QUEST_ATTRIBUTES = ['roof.shape', 'levels', 'colour'] as const;
export type QuestAttribute = (typeof QUEST_ATTRIBUTES)[number];

/**
 * A Quest: a nudge to photograph a building whose look is still imagined.
 * `unknown` quests are a pure function of Facts and resolve themselves once a
 * capture fills the gap; `unsure` ones come from the Ladder's human rung, when a
 * photo's answers were not confident enough to become Facts.
 */
export type Quest = {
  id: string;
  featureId: string;
  cell: string;
  ask: QuestAttribute[];
  reason: 'unknown' | 'unsure';
};

/** Quests per Cell: a few good ones beat a beacon on every roof. */
export const QUESTS_PER_CELL = 3;

/**
 * The most useful photos to take in a Cell. Deterministic: the same Facts and
 * unsure set give the same Quests on every device. Ranked by how much a photo
 * would add (unsure first, then the most unknown attributes), ties broken by a
 * hash of the Feature ID so the chosen buildings look scattered, not alphabetical.
 */
export function questsFor(
  cell: string,
  buildings: { id: string; attrs: ResolvedAttrs }[],
  unsure: ReadonlySet<string> = new Set(),
  limit = QUESTS_PER_CELL,
): Quest[] {
  const known = (a: ResolvedAttrs, q: QuestAttribute) =>
    q === 'levels' ? a.levels !== undefined || a.height !== undefined : a[q] !== undefined;
  return buildings
    .map((b) => {
      const ask = QUEST_ATTRIBUTES.filter((q) => !known(b.attrs, q));
      const isUnsure = unsure.has(b.id);
      return {
        quest: {
          id: `photo:${b.id}`,
          featureId: b.id,
          cell,
          ask: isUnsure && !ask.length ? [...QUEST_ATTRIBUTES] : ask,
          reason: isUnsure ? ('unsure' as const) : ('unknown' as const),
        },
        score: (isUnsure ? 10 : 0) + ask.length,
        tie: fnv1a32(`quest:${b.id}`),
      };
    })
    .filter((x) => x.quest.ask.length > 0)
    .sort((a, b) => b.score - a.score || a.tie - b.tie)
    .slice(0, limit)
    .map((x) => x.quest);
}
