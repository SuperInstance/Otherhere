import { describe, expect, it } from 'vitest';
import { describeFacts, sendSize } from '../src/feature';

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

describe('sendSize', () => {
  it('keeps a phone photo whole, at most 1280 px', () => {
    expect(sendSize(4032, 3024)).toEqual({
      sx: 0,
      sy: 0,
      sw: 4032,
      sh: 3024,
      width: 1280,
      height: 960,
    });
  });
  it('lifts a short panorama to the 280 px Jev needs, trimming only its ends', () => {
    const s = sendSize(8000, 1000);
    expect(s.height).toBe(280);
    expect(s.width).toBeLessThanOrEqual(1568);
    expect(s.sy).toBe(0);
    expect(s.sx).toBeGreaterThan(0);
  });
});
