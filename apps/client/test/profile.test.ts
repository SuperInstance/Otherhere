import { describe, expect, it } from 'vitest';
import { FULL_PROFILE, LITE_PROFILE, resolveProfile } from '../src/profile';

describe('resolveProfile', () => {
  it('defaults to full, in code and in a plain build', () => {
    expect(resolveProfile('')).toBe(FULL_PROFILE);
    expect(resolveProfile('', undefined)).toBe(FULL_PROFILE);
    expect(resolveProfile('?at=57.05,-135.33', 'full')).toBe(FULL_PROFILE);
  });
  it('the link wins over the build default, both ways', () => {
    expect(resolveProfile('?lite=1', 'full')).toBe(LITE_PROFILE);
    expect(resolveProfile('?lite=1')).toBe(LITE_PROFILE);
    expect(resolveProfile('?profile=lite')).toBe(LITE_PROFILE);
    expect(resolveProfile('?lite=0', 'lite')).toBe(FULL_PROFILE);
    expect(resolveProfile('?profile=full', 'lite')).toBe(FULL_PROFILE);
  });
  it('a lite build defaults to lite', () => {
    expect(resolveProfile('', 'lite')).toBe(LITE_PROFILE);
    expect(resolveProfile('?at=57.05,-135.33', 'lite')).toBe(LITE_PROFILE);
  });
  it('lite genuinely draws less than full', () => {
    expect(LITE_PROFILE.pixelRatioCap).toBeLessThan(FULL_PROFILE.pixelRatioCap);
    expect(LITE_PROFILE.forestDensity).toBeLessThan(FULL_PROFILE.forestDensity);
    expect(LITE_PROFILE.antialias).toBe(false);
  });
});
