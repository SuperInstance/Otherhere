/**
 * Coordinates written the way charts write them: degrees, minutes, seconds —
 * `57°03′11″N, 135°20′06″W` (Casey, 2026-10-24: a place is listed by its
 * address or name first; coordinates appear only when nothing is near, and
 * then in this form, never decimal).
 *
 * Display-only. A formatted string is presentation, not a Fact, and must
 * never feed Bundle bytes (invariant 2 is untouched: nothing here is hashed).
 */

function part(value: number, positive: string, negative: string): string {
  const hemisphere = value < 0 ? negative : positive;
  const abs = Math.abs(value);
  let degrees = Math.floor(abs);
  let minutes = Math.floor((abs - degrees) * 60);
  let seconds = Math.round(((abs - degrees) * 60 - minutes) * 60);
  if (seconds === 60) {
    seconds = 0;
    minutes += 1;
  }
  if (minutes === 60) {
    minutes = 0;
    degrees += 1;
  }
  const two = (n: number) => String(n).padStart(2, '0');
  return `${degrees}°${two(minutes)}′${two(seconds)}″${hemisphere}`;
}

/** Format a lat/lng pair as degrees/minutes/seconds with hemisphere letters. */
export function formatDMS(lat: number, lng: number): string {
  return `${part(lat, 'N', 'S')}, ${part(lng, 'E', 'W')}`;
}
