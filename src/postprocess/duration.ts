/**
 * Picks the raw video duration (§7.4): the container format duration, or — when it
 * reports N/A (ffmpeg killed before finalizing) — the last packet's pts_time.
 * `formatOut` / `packetOut` are the respective `ffprobe -of csv=p=0` outputs.
 */
export function chooseDuration(formatOut: string, packetOut: string): number {
  const fmt = Number(formatOut.trim());
  if (Number.isFinite(fmt) && fmt > 0) return fmt;
  const last = packetOut
    .trim()
    .split('\n')
    .map((l) => Number(l.trim()))
    .filter((n) => Number.isFinite(n))
    .at(-1);
  if (last === undefined || last <= 0) throw new Error(`No usable duration (format=${formatOut.trim()}, packets tail empty)`);
  return last;
}
