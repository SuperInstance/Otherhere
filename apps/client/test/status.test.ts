import { describe, expect, it } from 'vitest';
import { composeStatus, StatusLine, type StatusInput, type StatusTiers } from '../src/status';
import type { WorldStats } from '../src/world';

const stats: WorldStats = {
  ready: 7,
  loading: 0,
  sketch: 0,
  errors: 0,
  features: 1525,
  verified: 7,
  mismatched: 0,
  quests: 0,
  waking: 0,
};

const base: StatusInput = {
  backend: 'WebGPU',
  stats,
  sky: { hour: 9.5, cloud: 0.7, wind: 0.04 },
  skyFrozen: false,
  terrain: null,
  capsule: null,
  generatorsCurrent: true,
  questsDone: 0,
};

describe('composeStatus tiers (review P0 #2: what gift mode must not hide)', () => {
  it('puts the imagery attribution in the moment tier, where no compact panel hides it', () => {
    const tiers = composeStatus({
      ...base,
      terrain: { active: true, mode: 'satellite' },
    });
    expect(tiers.moment.join('\n')).toContain('Sentinel-2');
    const topo = composeStatus({ ...base, terrain: { active: true, mode: 'topo' } });
    expect(topo.moment.join('\n')).toContain('Mapzen Terrain Tiles');
  });

  it('puts the postcard title and the moment (clock, weather) in the moment tier', () => {
    const tiers = composeStatus({
      ...base,
      capsule: { title: 'Bahnhofplatz at dusk', createdAt: '2026-10-20T14:03:11Z' },
      skyFrozen: true,
    });
    expect(tiers.moment[0]).toBe(
      'Postcard: Bahnhofplatz at dusk · saved 2026-10-20 · built in your browser',
    );
    expect(tiers.moment[1]).toContain('the hour is pinned here');
  });

  it('keeps a clean hash count with the routine counts, but moves a mismatch to the live tier', () => {
    const clean = composeStatus({ ...base, stats: { ...stats, verified: 7 } });
    expect(clean.cells.join('\n')).toContain('7/7 bundle hashes verified');
    expect(clean.live).toHaveLength(0);

    const bad = composeStatus({ ...base, stats: { ...stats, verified: 6, mismatched: 1 } });
    expect(bad.cells.join('\n')).not.toContain('MISMATCHED');
    expect(bad.live.join('\n')).toContain('6/7 bundle hashes verified · 1 MISMATCHED');
  });

  it('puts errors, sketch, waking, quests and stale-generator notices in the live tier', () => {
    const tiers = composeStatus({
      ...base,
      stats: { ...stats, sketch: 2, errors: 1, quests: 3, waking: 1 },
      capsule: { title: 'T', createdAt: '2026-10-20T14:03:11Z' },
      generatorsCurrent: false,
      questsDone: 1,
    });
    const live = tiers.live.join('\n');
    expect(live).toContain('2 cells are still a sketch');
    expect(live).toContain('Something here just sharpened');
    expect(live).toContain('1 cell failed to load. Reload to retry.');
    expect(live).toContain('3 quests nearby: photograph a building under an amber beacon · 1 done');
    expect(live).toContain('Drawn with newer generators');
    expect(tiers.cells.join('\n')).toContain('WebGPU · 7 cells · 1,525 features');
  });
});

describe('StatusLine writes one span per line', () => {
  const makeSink = () => {
    const writes: { textContent: string }[][] = [];
    return {
      writes,
      sink: {
        replaceChildren(...nodes: unknown[]) {
          writes.push(nodes as { textContent: string }[]);
        },
      },
    };
  };

  it('writes each tier as one node per line, so a line is a whole visible thing', () => {
    const moment = makeSink();
    const live = makeSink();
    const cells = makeSink();
    const line = new StatusLine(moment.sink, live.sink, cells.sink, (t) => ({ textContent: t }));
    const tiers: StatusTiers = {
      moment: ['a first line', 'a second line'],
      live: ['one problem'],
      cells: ['counts'],
    };
    line.update(tiers);
    expect(moment.writes).toEqual([
      [{ textContent: 'a first line' }, { textContent: 'a second line' }],
    ]);
    expect(live.writes).toEqual([[{ textContent: 'one problem' }]]);
    expect(cells.writes).toEqual([[{ textContent: 'counts' }]]);
  });

  it('boots the pre-world line into the live tier, announced once and then quiet', () => {
    const moment = makeSink();
    const live = makeSink();
    const cells = makeSink();
    const line = new StatusLine(moment.sink, live.sink, cells.sink, (t) => ({ textContent: t }));
    line.boot('Finding you…');
    // The empty tiers were empty already: writing nothing is the point.
    expect(moment.writes).toEqual([]);
    expect(cells.writes).toEqual([]);
    expect(live.writes).toEqual([[{ textContent: 'Finding you…' }]]);
    line.boot('');
    expect(live.writes).toHaveLength(2);
    expect(live.writes[1]).toEqual([]);
  });

  it('writes a tier only when its lines change (a live region announces every rewrite)', () => {
    const moment = makeSink();
    const live = makeSink();
    const cells = makeSink();
    const line = new StatusLine(moment.sink, live.sink, cells.sink, (t) => ({ textContent: t }));
    const tiers: StatusTiers = {
      moment: ['9:30 · overcast'],
      live: ['1 cell failed to load. Reload to retry.'],
      cells: ['WebGPU · 7 cells · 1,525 features'],
    };
    line.update(tiers);
    expect(moment.writes).toHaveLength(1);
    expect(live.writes).toHaveLength(1);
    expect(cells.writes).toHaveLength(1);

    // The 500 ms tick recomposes the same world: no tier may be touched.
    line.update({ moment: [...tiers.moment], live: [...tiers.live], cells: [...tiers.cells] });
    expect(moment.writes).toHaveLength(1);
    expect(live.writes).toHaveLength(1);
    expect(cells.writes).toHaveLength(1);

    // A real change lands in one tier: only that tier is written.
    line.update({ ...tiers, live: ['2 cells failed to load. Reload to retry.'] });
    expect(moment.writes).toHaveLength(1);
    expect(live.writes).toHaveLength(2);
    expect(cells.writes).toHaveLength(1);
    expect(live.writes[1]).toEqual([{ textContent: '2 cells failed to load. Reload to retry.' }]);

    // And the same content again, via a fresh array: still silent.
    line.update({ ...tiers, live: ['2 cells failed to load. Reload to retry.'] });
    expect(live.writes).toHaveLength(2);
  });
});
