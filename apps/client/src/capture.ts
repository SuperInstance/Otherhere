import { parseGpx, poseAt, sampleTimes, type TrackPoint } from '@otherhere/core';
import type { World } from './world';
import type { Pose } from './url';
import { sendSize } from './feature';

export type WalkProgress = {
  done: number;
  total: number;
  sharpened: number;
  noBuilding: number;
  outsideTrack: number;
  /** Frames the video element could not produce (a seek that never settled). */
  unreadable: number;
  /** Buildings whose observe call failed or timed out; the walk went on. */
  failed: number;
};

/** How long one video seek may take before the frame is given up as unreadable. */
const SEEK_TIMEOUT_MS = 15_000;
/**
 * How far a landed seek may sit from its target and still count (s). Sampled
 * times are always at least 4 s apart, so this only ever admits the seek's
 * own landing, never the previous sample's.
 */
const SEEK_LANDED_S = 0.05;
/** How long one observe call may take before the walk gives up on that building. */
const OBSERVE_TIMEOUT_MS = 60_000;

/**
 * Seek a video element and resolve true when the frame is ready, or false if
 * the seek neither settles nor errors within `timeoutMs`. Without this bound,
 * a stalled seek (seen on synthetic WebM files in headless browsers) hangs the
 * whole walk forever, because `onseeked` simply never fires.
 */
export function seek(
  video: HTMLVideoElement,
  seconds: number,
  timeoutMs = SEEK_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const target = Math.min(seconds, Math.max(0, video.duration - 0.05));
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      video.onseeked = null;
      video.onerror = null;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    video.onseeked = () => {
      // A seek that already timed out can still finish and fire its `seeked`
      // after the next seek has begun. Chrome and Firefox move `currentTime`
      // to the new target the moment it is assigned, so position alone cannot
      // tell that late landing apart from this seek's own. `seeking` — the
      // browser's own record of a seek still in flight — is what settles it.
      if (!video.seeking && Math.abs(video.currentTime - target) < SEEK_LANDED_S) done(true);
    };
    video.onerror = () => done(false);
    video.currentTime = target;
  });
}

/** Read one frame per requested time (seconds) from a video file, as base64 JPEGs. */
export async function* videoFrames(
  file: File,
  times: number[],
  max = 1280,
): AsyncGenerator<{ t: number; jpeg: string | null }> {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = URL.createObjectURL(file);
  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error('This video format cannot be read by the browser.'));
    });
    const s = sendSize(video.videoWidth, video.videoHeight, max);
    const canvas = document.createElement('canvas');
    canvas.width = s.width;
    canvas.height = s.height;
    const ctx = canvas.getContext('2d')!;
    for (const t of times) {
      if (!(await seek(video, t, SEEK_TIMEOUT_MS))) {
        yield { t, jpeg: null }; // an unreadable frame must not stall the walk
        continue;
      }
      ctx.drawImage(video, s.sx, s.sy, s.sw, s.sh, 0, 0, s.width, s.height);
      const url = canvas.toDataURL('image/jpeg', 0.85);
      yield { t, jpeg: url.slice(url.indexOf(',') + 1) };
    }
  } finally {
    URL.revokeObjectURL(video.src);
  }
}

export async function videoDuration(file: File): Promise<number> {
  const video = document.createElement('video');
  video.preload = 'metadata';
  video.src = URL.createObjectURL(file);
  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('This video format cannot be read by the browser.'));
    });
    return video.duration;
  } finally {
    URL.revokeObjectURL(video.src);
  }
}

/**
 * Post one frame to the observe endpoint for one building. Never throws: a
 * timed-out, dropped or erroring observe is that building's failure, not the
 * walk's, so one slow building cannot abort the whole import.
 */
export async function postObservation(
  hit: { featureId: string; cell: string },
  jpeg: string,
): Promise<'sharpened' | 'empty' | 'failed'> {
  const send = () =>
    fetch(`/api/features/${encodeURIComponent(hit.featureId)}/observe`, {
      method: 'POST',
      body: JSON.stringify({ cell: hit.cell, image: jpeg }),
      // A stalled observe call must not hang the walk forever either.
      signal: AbortSignal.timeout(OBSERVE_TIMEOUT_MS),
    });
  try {
    let res = await send();
    if (res.status === 429) {
      // Rate-limited: wait as long as the edge asks, then try this building once more.
      const wait = Number(res.headers.get('retry-after') ?? 60);
      await new Promise((r) => setTimeout(r, Math.min(wait, 120) * 1000));
      res = await send();
    }
    if (!res.ok) return 'failed';
    return ((await res.json()) as { facts: unknown[] }).facts.length ? 'sharpened' : 'empty';
  } catch {
    // A timed-out or dropped observe is one building's failure, never the walk's.
    return 'failed';
  }
}

/**
 * Learn from a filmed walk: for each sampled frame, fly the camera to where the
 * walker was (from the GPS track; the video is assumed to start when the track
 * does), find the building they were facing, and observe it from the frame.
 * Frames go to the observe endpoint and are never stored.
 */
export async function learnFromWalk(opts: {
  video: File;
  gpx: string;
  world: World;
  pose: Pose;
  onProgress: (p: WalkProgress) => void;
  waitForCell: (x: number, z: number) => Promise<void>;
  onSharpened: (cell: string) => void;
}): Promise<WalkProgress> {
  const track: TrackPoint[] = parseGpx(opts.gpx);
  const duration = await videoDuration(opts.video);
  const times = sampleTimes(duration);
  return learnFromFrames(videoFrames(opts.video, times, 1280), {
    total: times.length,
    track,
    world: opts.world,
    pose: opts.pose,
    onProgress: opts.onProgress,
    waitForCell: opts.waitForCell,
    onSharpened: opts.onSharpened,
  });
}

/** The frame-consuming core of a walk import, testable without a video element. */
export async function learnFromFrames(
  frames:
    | AsyncIterable<{ t: number; jpeg: string | null }>
    | Iterable<{ t: number; jpeg: string | null }>,
  opts: {
    total: number;
    track: readonly TrackPoint[];
    world: Pick<World, 'frame' | 'buildingAlong'>;
    pose: Pose;
    onProgress: (p: WalkProgress) => void;
    waitForCell: (x: number, z: number) => Promise<void>;
    onSharpened: (cell: string) => void;
  },
): Promise<WalkProgress> {
  const p: WalkProgress = {
    done: 0,
    total: opts.total,
    sharpened: 0,
    noBuilding: 0,
    outsideTrack: 0,
    unreadable: 0,
    failed: 0,
  };
  const seen = new Set<string>();
  for await (const frame of frames) {
    if (frame.jpeg === null) {
      // An unreadable frame still moves the walk forward.
      p.unreadable++;
    } else {
      const at = poseAt(opts.track, opts.track[0]!.t + frame.t * 1000);
      if (!at) {
        p.outsideTrack++;
      } else {
        const pos = opts.world.frame.project(at);
        const x = pos.e;
        const z = -pos.n;
        // Look the way the walker was walking (three: yaw 0 faces -z, i.e. north).
        Object.assign(opts.pose, {
          x,
          z,
          y: 1.7,
          pitch: 0,
          yaw: Math.atan2(-at.heading.e, at.heading.n),
        });
        await opts.waitForCell(x, z);
        const hit = opts.world.buildingAlong(x, z, { x: at.heading.e, z: -at.heading.n });
        if (!hit) p.noBuilding++;
        else if (!seen.has(hit.featureId)) {
          seen.add(hit.featureId);
          const outcome = await postObservation(hit, frame.jpeg);
          if (outcome === 'sharpened') {
            p.sharpened++;
            opts.onSharpened(hit.cell);
          } else if (outcome === 'failed') {
            p.failed++;
          }
        }
      }
    }
    // Every sampled frame counts, readable or not, so done reaches total.
    p.done++;
    opts.onProgress({ ...p });
  }
  return p;
}
