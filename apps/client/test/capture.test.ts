import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seek } from '../src/capture';

/** The slice of HTMLVideoElement that `seek` touches, as a plain object. */
function fakeVideo(duration = 24, seekDelayMs = 0) {
  const v = {
    duration,
    currentTime: 0,
    onseeked: null as (() => void) | null,
    onerror: null as (() => void) | null,
  };
  return {
    v,
    /** Setting currentTime lands the seek after `seekDelayMs`, like a real element. */
    land() {
      setTimeout(() => v.onseeked?.(), seekDelayMs);
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('seek', () => {
  it('resolves true when the seek settles in time', async () => {
    const { v } = fakeVideo();
    const p = seek(v as unknown as HTMLVideoElement, 5, 1000);
    await vi.advanceTimersByTimeAsync(10); // the seek lands quickly
    v.onseeked?.();
    await expect(p).resolves.toBe(true);
  });

  it('clamps the target inside the video duration', async () => {
    const { v } = fakeVideo(24);
    const p = seek(v as unknown as HTMLVideoElement, 99, 1000);
    expect(v.currentTime).toBe(23.95); // duration - 0.05, never past the end
    v.onseeked?.();
    await expect(p).resolves.toBe(true);
  });

  it('resolves false when onseeked never fires (the stalled-seek hang)', async () => {
    const { v } = fakeVideo();
    const p = seek(v as unknown as HTMLVideoElement, 5, 1000);
    await vi.advanceTimersByTimeAsync(1000); // nothing lands
    await expect(p).resolves.toBe(false);
  });

  it('resolves false when the video errors instead', async () => {
    const { v } = fakeVideo();
    const p = seek(v as unknown as HTMLVideoElement, 5, 1000);
    v.onerror?.();
    await expect(p).resolves.toBe(false);
  });

  it('ignores a late onseeked after the timeout already resolved', async () => {
    const { v } = fakeVideo();
    const p = seek(v as unknown as HTMLVideoElement, 5, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toBe(false);
    v.onseeked?.(); // fires after the deadline: must not throw or re-resolve
    await expect(p).resolves.toBe(false);
  });

  it('clears its handlers so two seeks do not cross-talk', async () => {
    const { v } = fakeVideo();
    const a = seek(v as unknown as HTMLVideoElement, 1, 1000);
    v.onseeked?.();
    await expect(a).resolves.toBe(true);
    expect(v.onseeked).toBeNull();
    expect(v.onerror).toBeNull();
    const b = seek(v as unknown as HTMLVideoElement, 2, 1000);
    v.onerror?.();
    await expect(b).resolves.toBe(false);
  });
});
