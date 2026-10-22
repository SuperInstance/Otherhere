import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseGpx } from '@otherhere/core';
import { learnFromFrames, postObservation, seek, type WalkProgress } from '../src/capture';

/**
 * The slice of HTMLVideoElement that `seek` touches, as a plain object —
 * behaving the way Chrome and Firefox do: assigning `currentTime` moves the
 * reported position to the new target at once, and the element is officially
 * `seeking` from that assignment until the frame is ready (review P0 #2).
 */
function fakeVideo(duration = 24) {
  const v = {
    duration,
    seeking: false,
    onseeked: null as (() => void) | null,
    onerror: null as (() => void) | null,
  };
  let position = 0;
  Object.defineProperty(v, 'currentTime', {
    get: () => position,
    set: (t: number) => {
      position = t;
      v.seeking = true;
    },
  });
  return {
    v: v as typeof v & { currentTime: number },
    /** The browser lands a seek: the position settles, seeking drops, `seeked` fires. */
    land(t: number) {
      position = t;
      v.seeking = false;
      v.onseeked?.();
    },
    /**
     * An older, timed-out seek completes late while a newer seek is in flight:
     * the `seeked` event fires, but the element is still officially seeking
     * (and `currentTime` has read the new target since it was assigned).
     */
    lateSeeked() {
      v.onseeked?.();
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('seek', () => {
  it('resolves true when the seek settles in time', async () => {
    const { v, land } = fakeVideo();
    const p = seek(v as unknown as HTMLVideoElement, 5, 1000);
    await vi.advanceTimersByTimeAsync(10); // the seek lands quickly
    land(5);
    await expect(p).resolves.toBe(true);
  });

  it('clamps the target inside the video duration', async () => {
    const { v, land } = fakeVideo();
    const p = seek(v as unknown as HTMLVideoElement, 99, 1000);
    expect(v.currentTime).toBe(23.95); // duration - 0.05, never past the end
    land(23.95);
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
    const { v, land } = fakeVideo();
    const p = seek(v as unknown as HTMLVideoElement, 5, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toBe(false);
    land(5); // the browser finishes the seek after the deadline: no re-resolve
    await expect(p).resolves.toBe(false);
  });

  it('clears its handlers so two seeks do not cross-talk', async () => {
    const { v, land } = fakeVideo();
    const a = seek(v as unknown as HTMLVideoElement, 1, 1000);
    land(1);
    await expect(a).resolves.toBe(true);
    expect(v.onseeked).toBeNull();
    expect(v.onerror).toBeNull();
    const b = seek(v as unknown as HTMLVideoElement, 2, 1000);
    v.onerror?.();
    await expect(b).resolves.toBe(false);
  });

  it('does not settle the next seek with a late seeked from a timed-out seek (review P0 #2)', async () => {
    // The real-browser race: a seek times out and the walk moves on; the next
    // seek is assigned, so `currentTime` already reads its target; the old
    // seek's `seeked` fires while the new one is still in flight. Position
    // alone cannot tell that event from the new seek's own landing — the
    // position guard passes in Chrome and Firefox. `seeking` is what tells.
    const { v, land, lateSeeked } = fakeVideo();
    const a = seek(v as unknown as HTMLVideoElement, 5, 1000);
    await vi.advanceTimersByTimeAsync(1000); // the seek to 5 s gives up...
    await expect(a).resolves.toBe(false); // ...but the browser is still seeking there
    let settled = false;
    const b = seek(v as unknown as HTMLVideoElement, 10, 1000).then((ok) => {
      settled = true;
      return ok;
    });
    expect(v.currentTime).toBe(10); // the browser moved it on assignment
    expect(v.seeking).toBe(true); // and is still seeking
    lateSeeked(); // the timed-out seek fires its event into the new handler
    await vi.advanceTimersByTimeAsync(5);
    expect(settled).toBe(false); // it must not resolve the seek to 10 s
    land(10); // the second seek really lands
    await expect(b).resolves.toBe(true);
  });

  it('keeps waiting when a seeked event arrives at the wrong position', async () => {
    const { v, land } = fakeVideo();
    const p = seek(v as unknown as HTMLVideoElement, 8, 1000);
    land(3); // an event from somewhere else entirely
    await vi.advanceTimersByTimeAsync(5);
    let settled = false;
    p.then(() => (settled = true));
    expect(settled).toBe(false);
    land(8);
    await expect(p).resolves.toBe(true);
  });
});

describe('postObservation', () => {
  const hit = { cell: 'c1', featureId: 'osm-1' };
  const json = (facts: unknown[]) =>
    new Response(JSON.stringify({ facts }), { headers: { 'content-type': 'application/json' } });

  it('reports sharpened when the endpoint returns facts', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json([{ facade: 'brick' }]));
    vi.stubGlobal('fetch', fetchMock);
    await expect(postObservation(hit, 'aa')).resolves.toBe('sharpened');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/features/osm-1/observe',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('reports empty when the model had nothing to say', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json([])));
    await expect(postObservation(hit, 'aa')).resolves.toBe('empty');
  });

  it('counts a server error as a failed building, not a crash', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 500 })));
    await expect(postObservation(hit, 'aa')).resolves.toBe('failed');
  });

  it('survives a timed-out observe call instead of aborting the walk', async () => {
    // The P0: one slow building used to reject the whole import.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new DOMException('signal timed out', 'TimeoutError')),
    );
    await expect(postObservation(hit, 'aa')).resolves.toBe('failed');
  });

  it('waits as the edge asks after a 429, then tries once more', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('slow down', { status: 429, headers: { 'retry-after': '30' } }),
      )
      .mockResolvedValueOnce(json([{ facade: 'brick' }]));
    vi.stubGlobal('fetch', fetchMock);
    const p = postObservation(hit, 'aa');
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(p).resolves.toBe('sharpened');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

/** A short track east through the test world; frames land inside it. */
function track(): ReturnType<typeof parseGpx> {
  const t0 = Date.parse('2026-10-18T09:00:00Z');
  const pts = [
    [47.0, 8.0],
    [47.0, 8.001],
  ].map(([lat, lng], i) => {
    const t = new Date(t0 + i * 24_000).toISOString();
    return `<trkpt lat="${lat}" lon="${lng}"><time>${t}</time></trkpt>`;
  });
  return parseGpx(
    `<?xml version="1.0"?><gpx version="1.1" creator="t"><trk><trkseg>${pts.join('')}</trkseg></trk></gpx>`,
  );
}

/** A world whose frame is metres-from-origin and whose buildings answer in order. */
function fakeWorld(hits: ({ cell: string; featureId: string } | null)[]) {
  let i = 0;
  return {
    frame: {
      project: (p: { lat: number; lng: number }) => ({ e: p.lng * 78_000, n: p.lat * 111_000 }),
    },
    buildingAlong: () => hits[Math.min(i++, hits.length - 1)],
  };
}

function framesOf(list: (string | null)[]): { t: number; jpeg: string | null }[] {
  return list.map((jpeg, i) => ({ t: 2 + i * 4, jpeg }));
}

describe('learnFromFrames', () => {
  const base = {
    track: track(),
    pose: { x: 0, z: 0, y: 1.7, pitch: 0, yaw: 0 },
    waitForCell: async () => {},
  };

  it('counts an unreadable frame towards done so the progress line can finish', async () => {
    const seen: WalkProgress[] = [];
    const p = await learnFromFrames(framesOf([null, 'aa', 'bb']), {
      ...base,
      total: 3,
      world: fakeWorld([null]) as never,
      onProgress: (x) => seen.push({ ...x }),
      onSharpened: () => {},
    });
    expect(p.done).toBe(3); // the unreadable frame included, not swallowed
    expect(p.unreadable).toBe(1);
    expect(p.noBuilding).toBe(2);
    expect(seen.at(-1)).toMatchObject({ done: 3, total: 3 });
  });

  it('survives an observe call that fails, and later buildings still sharpen', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockRejectedValueOnce(new DOMException('signal timed out', 'TimeoutError'))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ facts: [{ facade: 'brick' }] }), {
            headers: { 'content-type': 'application/json' },
          }),
        ),
    );
    const sharpened: string[] = [];
    const p = await learnFromFrames(framesOf(['aa', 'bb']), {
      ...base,
      total: 2,
      world: fakeWorld([
        { cell: 'c1', featureId: 'f1' },
        { cell: 'c2', featureId: 'f2' },
      ]) as never,
      onProgress: () => {},
      onSharpened: (cell) => sharpened.push(cell),
    });
    expect(p.failed).toBe(1); // one slow building is one building's failure
    expect(p.sharpened).toBe(1); // the walk went on
    expect(sharpened).toEqual(['c2']);
  });

  it('observes each distinct building once', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ facts: [{ facade: 'brick' }] }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const p = await learnFromFrames(framesOf(['aa', 'bb', 'cc']), {
      ...base,
      total: 3,
      world: fakeWorld([
        { cell: 'c1', featureId: 'f1' },
        { cell: 'c1', featureId: 'f1' },
      ]) as never,
      onProgress: () => {},
      onSharpened: () => {},
    });
    expect(fetchMock).toHaveBeenCalledTimes(1); // the same building is not re-asked
    expect(p.sharpened).toBe(1);
    expect(p.noBuilding).toBe(0); // every frame faced that building
  });
});
