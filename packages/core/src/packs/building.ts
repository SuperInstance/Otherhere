import { QuestionPack, type Answers } from '../schema/question-pack';
import type { Fact, Source } from '../schema/fact';
import building from './building.v1.json';

export const BUILDING_PACK: QuestionPack = QuestionPack.parse(building);

/** Hex colours drawn for each named colour answer. */
export const WALL_COLOURS: Record<string, string> = {
  white: '#f2f0ea',
  cream: '#efe4c8',
  beige: '#e3d5b8',
  brick: '#a5543f',
  ochre: '#d9a441',
  terracotta: '#c98f6d',
  pink: '#e2b6b0',
  grey: '#a7a8a6',
  blue: '#8fa7bf',
  green: '#8fae8a',
  dark: '#4a4642',
};
export const ROOF_COLOURS: Record<string, string> = {
  red: '#a0573f',
  brown: '#7a5a43',
  dark: '#4f5359',
  light: '#b8b8b2',
  green: '#6f9a86',
};
const FLOORS: Record<string, number> = {
  '1': 1,
  '2': 2,
  '3': 3,
  '4': 4,
  '5': 5,
  '6-8': 7,
  '9-14': 11,
  '15+': 18,
};

/** Below this, an answer becomes no Fact at all: imagined beats wrong. */
/**
 * A field becomes a Fact only when its own confidence times P(one building
 * visible) reaches this. Gating each field, not the whole pack, keeps the good
 * answers when one is shaky: on our photo sets it wrote over 3× as many correct
 * Facts with no more wrong ones (docs/notes/model-field-notes.md). Capture Facts
 * outrank OSM, so the bar favours precision.
 */
export const MIN_ANSWER_CONFIDENCE = 0.7;

/**
 * Turn building-pack answers into Facts. Each Fact's confidence is the answer's
 * confidence times the probability the observation really showed one building.
 */
export function buildingFacts(
  answers: Answers,
  opts: { featureId: string; source: Source; observedAt: string },
): Fact[] {
  const visible = answers.visible?.type === 'noul' ? answers.visible.noul : 0;
  const out: Fact[] = [];
  const add = (attribute: string, value: Fact['value'], conf: number) => {
    const confidence = Math.round(conf * visible * 1000) / 1000;
    if (confidence >= MIN_ANSWER_CONFIDENCE) {
      out.push({
        featureId: opts.featureId,
        attribute,
        value,
        source: opts.source,
        confidence,
        observedAt: opts.observedAt,
        version: 1,
      });
    }
  };
  const choice = (id: string) => {
    const a = answers[id];
    return a?.type === 'choice' && a.choice !== 'unknown' ? a : null;
  };
  const roof = choice('roof_shape');
  if (roof && ['flat', 'gable', 'hip', 'shed'].includes(roof.choice))
    add('roof.shape', roof.choice, roof.confidence);
  const floors = choice('floors');
  if (floors && FLOORS[floors.choice]) add('levels', FLOORS[floors.choice]!, floors.confidence);
  const wall = choice('wall_colour');
  if (wall && WALL_COLOURS[wall.choice]) add('colour', WALL_COLOURS[wall.choice]!, wall.confidence);
  const roofColour = choice('roof_colour');
  if (roofColour && ROOF_COLOURS[roofColour.choice])
    add('roof.colour', ROOF_COLOURS[roofColour.choice]!, roofColour.confidence);
  return out;
}
