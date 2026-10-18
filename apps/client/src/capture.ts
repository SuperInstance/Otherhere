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
};

/** Read one frame per requested time (seconds) from a video file, as base64 JPEGs. */
export async function* videoFrames(
  file: File,
  times: number[],
  max = 1280,
): AsyncGenerator<{ t: number; jpeg: string }> {
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
      await new Promise<void>((resolve) => {
        video.onseeked = () => resolve();
        video.currentTime = Math.min(t, Math.max(0, video.duration - 0.05));
      });
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
  const p: WalkProgress = {
    done: 0,
    total: times.length,
    sharpened: 0,
    noBuilding: 0,
    outsideTrack: 0,
  };
  const seen = new Set<string>();
  for await (const frame of videoFrames(opts.video, times)) {
    const at = poseAt(track, track[0]!.t + frame.t * 1000);
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
        const res = await fetch(`/api/features/${encodeURIComponent(hit.featureId)}/observe`, {
          method: 'POST',
          body: JSON.stringify({ cell: hit.cell, image: frame.jpeg }),
        });
        if (res.ok && ((await res.json()) as { facts: unknown[] }).facts.length) {
          p.sharpened++;
          opts.onSharpened(hit.cell);
        }
      }
    }
    p.done++;
    opts.onProgress({ ...p });
  }
  return p;
}
