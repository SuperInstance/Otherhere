import { timeLine } from './sky';
import { TERRAIN_ATTRIBUTION } from './terrain';
import type { WorldStats } from './world';

/**
 * The status line, in three tiers (round 7; review P0 #2 and #4):
 *
 *   #status-moment  the scene — the postcard's title, the moment (clock, weather),
 *                   and the imagery attribution invariant 8 owes the licence.
 *                   Always visible, including gift mode and the compact phone
 *                   panel. Not a live region: the clock ticks twice a second.
 *   #status         problems and notices — a failed hash check (announced
 *                   once, then quiet while more Cells land; the running
 *                   counts stay below), failed cells, sketch retries, the
 *                   wake-up, quests, stale-generator notices.
 *                   Always visible; a licence, an error or a hash-check
 *                   notice is never clipped away. aria-live="polite",
 *                   announced.
 *   #status-cells   the routine counts — backend, cells, features, hash checks.
 *                   Visible in full; in gift mode and the compact phone panel it
 *                   waits behind More options (a whole tier hides; a line is
 *                   never cut mid-line). Not a live region: the counts change
 *                   on every cell landing, so announcing them reads a running
 *                   counter through every load and every walk. The one fact a
 *                   listener needs — the place is loaded — is said once per
 *                   quiet load through the visually hidden #announce region
 *                   (LoadAnnouncer; review of rounds 06-07, item 3).
 *
 * The ticking clock lives in the moment tier, which is not a live region, and
 * every tier is written only when its lines change (see StatusLine) — so a
 * screen reader hears the place load, then quiet (review P0 #4).
 */

export type StatusTiers = { moment: string[]; live: string[]; cells: string[] };

export type StatusInput = {
  backend: string;
  stats: WorldStats;
  sky: { hour: number; cloud: number; wind: number };
  skyFrozen: boolean;
  terrain: { active: boolean; mode: 'topo' | 'satellite' } | null | undefined;
  capsule: { title: string; createdAt: string } | null;
  /** False when the world is being drawn by newer generators than it was saved with. */
  generatorsCurrent: boolean;
  questsDone: number;
};

export function composeStatus(input: StatusInput): StatusTiers {
  const { backend, stats: s, sky, skyFrozen, terrain, capsule, generatorsCurrent } = input;
  const moment: string[] = [];
  const live: string[] = [];
  const cells: string[] = [];

  if (capsule)
    moment.push(
      `Postcard: ${capsule.title} · saved ${capsule.createdAt.slice(0, 10)} · built in your browser`,
    );
  moment.push(timeLine(sky.hour, sky.cloud, skyFrozen, sky.wind));
  if (terrain?.active)
    moment.push(
      `${terrain.mode === 'topo' ? 'Topographic' : 'Satellite'} (M to switch) · ${TERRAIN_ATTRIBUTION[terrain.mode]}`,
    );

  cells.push(
    `${backend} · ${s.ready} cell${s.ready === 1 ? '' : 's'}${s.loading ? ` (+${s.loading} loading)` : ''} · ${s.features.toLocaleString()} features`,
  );
  // The counts line, with its MISMATCHED tail, belongs to the quiet tier: it
  // changes on every Cell that lands, and a live region would read it as a
  // running counter (review P1 #8). The mismatch itself is a problem the
  // player must hear and see, so it is said aloud — once. The announcement
  // names only the mismatch count, which stays stable while healthy Cells
  // keep landing: the StatusLine's change gate then keeps the live region
  // quiet, and a second, different problem (the count growing) is a real
  // change that deserves a new announcement.
  cells.push(
    `${s.verified}/${s.ready} bundle hashes verified${s.mismatched ? ` · ${s.mismatched} MISMATCHED` : ''}`,
  );
  if (s.mismatched) {
    live.push(
      s.mismatched === 1
        ? '1 cell failed its hash check — it may look wrong. Reload to redraw it.'
        : `${s.mismatched} cells failed their hash checks — parts may look wrong. Reload to redraw them.`,
    );
  }

  if (s.sketch) {
    const are = s.sketch === 1 ? '1 cell is' : `${s.sketch} cells are`;
    live.push(`${are} still a sketch: waiting for OpenStreetMap, trying again shortly.`);
  }
  if (s.waking)
    live.push(
      s.waking === 1
        ? 'Something here just sharpened: the new knowledge is settling in.'
        : `${s.waking} cells just sharpened: new knowledge settling in.`,
    );
  if (s.errors)
    live.push(`${s.errors} cell${s.errors === 1 ? '' : 's'} failed to load. Reload to retry.`);
  if (s.quests) {
    const done = input.questsDone;
    live.push(
      `${s.quests} quest${s.quests === 1 ? '' : 's'} nearby: photograph a building under an amber beacon${done ? ` · ${done} done` : ''}`,
    );
  }
  if (capsule && !generatorsCurrent)
    live.push('Drawn with newer generators than it was saved with, so details may differ.');

  return { moment, live, cells };
}

/** Anything replaceChildren writes lines into: a real `<p>` in the page, a fake in tests. */
export type LineSink = {
  replaceChildren(...nodes: unknown[]): void;
};

/**
 * Says "Loaded" once per quiet load, into a short visually hidden live region.
 * The routine counters are not a live region (they would read as a running
 * counter), so this is the single announcement a listener gets that the place
 * stood up. A burst of landings must read as one moment: the announcement
 * waits for `quietMs` of no loading in flight, and a new burst cancels it.
 */
export class LoadAnnouncer {
  private loading = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly announce: (text: string) => void,
    private readonly quietMs = 1_500,
  ) {}

  /** Called with the world's loading and ready counts on every status tick. */
  update(loading: number, ready: number): void {
    if (loading > 0) {
      this.loading = true;
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      return;
    }
    // Nothing to say before the first load, and only one pending announcement.
    if (!this.loading || ready === 0 || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.loading = false;
      this.announce('Loaded');
    }, this.quietMs);
  }
}

const linesChanged = (a: string[], b: string[]) =>
  a.length !== b.length || a.some((line, i) => line !== b[i]);

/**
 * Writes the tiers, one `<span>` per line, so a line is a thing tests and
 * accessibility tools can see whole: `toBeVisible()` on a clipped line fails,
 * while `toContainText` cannot tell clipped from shown.
 *
 * A tier is written only when its lines actually change: a live region
 * announces on every DOM mutation, even a rewrite with identical text, so the
 * 500 ms status tick must never touch an unchanged tier — a screen reader
 * would re-announce it twice a second (review P0 #4).
 */
export class StatusLine {
  private written: StatusTiers = { moment: [], live: [], cells: [] };

  constructor(
    private readonly moment: LineSink,
    private readonly live: LineSink,
    private readonly cells: LineSink,
    private readonly span: (text: string) => { textContent: string },
  ) {}

  /** The one pre-world line ("Finding you…", "Enter coordinates…"), announced once. */
  boot(text: string): void {
    this.update({ moment: [], live: text ? [text] : [], cells: [] });
  }

  update(tiers: StatusTiers): void {
    if (linesChanged(this.written.moment, tiers.moment)) {
      this.written.moment = [...tiers.moment];
      this.moment.replaceChildren(...tiers.moment.map((t) => this.span(t)));
    }
    if (linesChanged(this.written.live, tiers.live)) {
      this.written.live = [...tiers.live];
      this.live.replaceChildren(...tiers.live.map((t) => this.span(t)));
    }
    if (linesChanged(this.written.cells, tiers.cells)) {
      this.written.cells = [...tiers.cells];
      this.cells.replaceChildren(...tiers.cells.map((t) => this.span(t)));
    }
  }
}
