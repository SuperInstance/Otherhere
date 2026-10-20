// Round-2 evidence helper: the weather each biome actually serves over a full
// living day, and the light that follows the sun through the arc. Pure reads of
// src/sky.ts (the same functions the client runs), printed as a table for the
// round note. Not part of the app; lives with the probe tooling.
import { cloudCover, describeWeather, skyPalette, sunPosition, DAY_OF_YEAR } from '../src/sky';

const places = [
  ['Zürich', 47.3769, 'temperate'],
  ['Sitka', 57.0531, 'pacific-rainforest'],
] as const;

console.log('== weather served over one full day (every 10 s of a living day) ==');
for (const [name, , biome] of places) {
  const counts: Record<string, number> = {};
  for (let t = 0; t <= 1440; t += 10) {
    const hour = 9.5 + t / 60; // a visit that opens at DAY_START_HOUR and lives one day
    const w = describeWeather(cloudCover(hour, biome as 'temperate' | 'pacific-rainforest'));
    counts[w] = (counts[w] ?? 0) + 1;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const share = Object.entries(counts)
    .map(([w, n]) => `${w} ${((100 * n) / total).toFixed(0)}%`)
    .join(' · ');
  console.log(`${name.padEnd(7)} (${biome}): ${share}`);
}

console.log("\n== the arc at the probe's key hours: sun, weather, light ==");
console.log('hour  sunEl  cloud  weather            lightI  hemiI  stars  moon  haze  mist');
for (const h of [5.5, 7.25, 12, 15.5, 19.75, 22.5]) {
  // Zürich temperate; the weather is the hour's own (cloudCover is keyed to
  // the day hour, so a pinned ?t= or a postcard link serves exactly this).
  const el = sunPosition(47.3769, DAY_OF_YEAR, h).elevation;
  const cloud = cloudCover(h, 'temperate');
  const p = skyPalette(el, cloud);
  console.log(
    String(h).padStart(4),
    el.toFixed(1).padStart(6),
    cloud.toFixed(2).padStart(6),
    describeWeather(cloud).padEnd(18),
    p.lightIntensity.toFixed(2).padStart(6),
    p.hemiIntensity.toFixed(2).padStart(6),
    p.stars.toFixed(2).padStart(6),
    p.moon.toFixed(2).padStart(5),
    p.hazeScale.toFixed(2).padStart(6),
    p.mist.toFixed(2).padStart(5),
  );
}
