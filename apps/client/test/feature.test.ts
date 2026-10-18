import { describe, expect, it } from 'vitest';
import { describeFacts } from '../src/feature';

describe('describeFacts', () => {
  it('names each Fact with its source and confidence, and says what is imagined', () => {
    expect(
      describeFacts({
        'roof.shape': { value: 'gable', confidence: 0.9, source: 'capture' },
        building: { value: 'house', confidence: 0.9, source: 'osm' },
        colour: { value: '#a5543f', confidence: 0.8, source: 'capture' },
      }),
    ).toEqual([
      'Type: house (from OpenStreetMap, 90% sure)',
      'Roof: gable (from a photo, 90% sure)',
      'Walls: brick (from a photo, 80% sure)',
      'Height: imagined',
    ]);
  });
});
