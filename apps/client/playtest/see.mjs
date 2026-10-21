// see.mjs — the fresh-eyes reading: what does someone see in this frame?
//
// A local playtest instrument (like the delegation tools: paid API, run by an
// engineer, never in CI or runtime; ~$0.0001 a run). Playwright hands it a
// screenshot — any scene the probe can reach — and Jev answers a designed
// question pack about it: where the eye lands, what the world seems to be
// saying, what reads as confusing. Between human rounds, it is a second pair of
// eyes that has never seen the product before — the opposite of a baseline.
//
// Usage:
//   node playtest/see.mjs --base https://otherhere.superinstance.dev --tag live-see
//   node playtest/see.mjs --base http://localhost:8787 --at 47.3769,8.5417 --t 9.5 --seed --tag zurich-see
//   node playtest/see.mjs --shot path/to/frame.png          # read an existing PNG
//
// The key never touches a log line; it is read from env or the workspace file.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const BASE = arg('base', 'https://otherhere.superinstance.dev');
const AT = arg('at', '');
const PINNED_T = arg('t', '');
const TAG = arg('tag', 'see');
const SHOT = arg('shot', '');
const PHONE = process.argv.includes('--phone');
const SEED = process.argv.includes('--seed');
const OUT =
  process.env.PLAYTEST_OUT ??
  new URL('../../../../otherhere-lab/playtest-artifacts/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

function loadKey() {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  for (const p of ['../../../.env.local', '../../../../.env.local']) {
    try {
      const line = readFileSync(new URL(p, import.meta.url), 'utf8')
        .split('\n')
        .find((l) => l.startsWith('TYPESAFE_API_KEY='));
      if (line) return line.slice('TYPESAFE_API_KEY='.length).trim();
    } catch {
      // try the next
    }
  }
  throw new Error('TYPESAFE_API_KEY not found (env or .env.local)');
}

/** Fit to Jev's accepted image bounds: every side 280–1568 px. */
async function fitForJevNode(png) {
  const sharp = (await import('sharp')).default ?? (await import('sharp'));
  return sharp(png).resize(1024, 640, { fit: 'contain' }).jpeg({ quality: 85 }).toBuffer();
}

// --- capture -------------------------------------------------------------------
let png;
if (SHOT) {
  png = readFileSync(SHOT);
} else {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: PHONE ? { width: 390, height: 844 } : { width: 1280, height: 800 },
  });
  const parts = [];
  if (AT) parts.push(`at=${encodeURIComponent(AT)}`);
  if (PINNED_T) parts.push(`t=${encodeURIComponent(PINNED_T)}`);
  if (SEED) parts.push('seed=1');
  await page.goto(`${BASE}/${parts.length ? `?${parts.join('&')}` : ''}`);
  const stats = () => page.evaluate(() => window.__otherhere?.stats ?? { ready: 0, loading: 1 });
  const t0 = Date.now();
  for (;;) {
    const s = await stats();
    if (s.ready >= 1 && s.loading === 0) break;
    if (Date.now() - t0 > 90_000) throw new Error('settle timeout');
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(1500);
  png = await page.screenshot();
  await browser.close();
}
writeFileSync(`${OUT}/${TAG}-frame.png`, png);
const jpeg = await fitForJevNode(png);

// --- the question pack ------------------------------------------------------------
const ph = 'img-frame';
const body = {
  model: 'jev-1.13.0',
  state: [
    'You are looking at a screenshot of a 3D place-exploration app the way a first-time player would.',
    'It renders real-world map data as a paper-and-ink model town that can stand up into detail.',
    'Answer about what THIS frame communicates to someone who has never seen the app.',
    ph,
  ].join('\n'),
  assets: { [ph]: { type: 'image', format: 'jpg', data_base64: jpeg.toString('base64') } },
  questions: {
    lands: {
      type: 'choice',
      instructions: 'Where does the eye land first?',
      criteria: {
        buildings: 'the buildings or streets',
        water: 'water or the horizon',
        sky: 'the sky',
        text_ui: 'text or interface elements',
        nothing: 'nothing stands out; the frame is uniform',
      },
    },
    reads_as: {
      type: 'choice',
      instructions: 'What does the world itself seem to be saying?',
      criteria: {
        paper_model: 'a paper or ink model of a real place',
        realistic_game: 'a realistic game world',
        map: 'a map or data visualisation',
        unclear: 'none of these comes across',
      },
    },
    state_clear: {
      type: 'noul',
      instructions: 'Does the frame communicate that the world is still loading or settling?',
      criteria: {
        true: 'something visibly unfinished or moving',
        false: 'the world reads as complete and still',
      },
    },
    confusing: {
      type: 'choice',
      instructions: 'What would most confuse a first-time player here?',
      criteria: {
        nothing_obvious: 'nothing obviously confusing',
        unreadable_text: 'text too small, faint, or overlapping',
        flat_vs_real: 'unclear what is finished vs unfinished geometry',
        no_affordance: 'no hint of what to do next',
        visual_noise: 'cluttered or noisy rendering',
      },
    },
    mood: {
      type: 'score',
      instructions: 'How calm does the frame feel, 1 (restless) to 10 (deeply calm)?',
      criteria: [
        'restless, busy, agitated',
        'somewhat busy',
        'neutral',
        'fairly calm',
        'calm, composed',
        'very calm',
        'quiet',
        'still',
        'serene',
        'deeply calm, like held breath',
      ],
    },
  },
};

const res = await fetch('https://api.typesafe.ai/v1/systemone', {
  method: 'POST',
  headers: {
    authorization: `Bearer ${loadKey()}`,
    'content-type': 'application/json',
    'TypeSafe-Danger-Zone-Images': 'true',
  },
  body: JSON.stringify(body),
});
const j = await res.json();
if (!res.ok) {
  console.error(`jev HTTP ${res.status}: ${JSON.stringify(j).slice(0, 300)}`);
  process.exit(1);
}
const out = {
  tag: TAG,
  model: j.model,
  usage: j.usage,
  answers: j.answers,
  at: new Date().toISOString(),
};
writeFileSync(`${OUT}/${TAG}-see.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
