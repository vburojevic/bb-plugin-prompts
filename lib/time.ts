// Time parsing shared by the CLI, the agent tools, and the tests.

const RELATIVE = /^\+(\d+)\s*([smhd])$/i;
const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** `--at` values: +30s, +5m, +2h, +1d, or an ISO-8601 timestamp. */
export function parseWhen(raw: string, nowMs: number): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const relative = RELATIVE.exec(trimmed);
  if (relative) {
    const amount = Number(relative[1]);
    if (!Number.isFinite(amount)) return null;
    const unit = UNIT_MS[relative[2]!.toLowerCase() as keyof typeof UNIT_MS];
    return nowMs + amount * unit;
  }
  const absolute = Date.parse(trimmed);
  return Number.isNaN(absolute) ? null : absolute;
}

/** "in 42 minutes" / "3 hours ago" — coarse on purpose. */
export function describeWhen(ms: number, nowMs: number): string {
  const delta = ms - nowMs;
  const ahead = delta >= 0;
  const seconds = Math.round(Math.abs(delta) / 1000);
  const [value, unit] =
    seconds < 60
      ? [seconds, "second"]
      : seconds < 3600
        ? [Math.round(seconds / 60), "minute"]
        : seconds < 86400
          ? [Math.round(seconds / 3600), "hour"]
          : [Math.round(seconds / 86400), "day"];
  const plural = value === 1 ? unit : `${unit}s`;
  return ahead ? `in ${value} ${plural}` : `${value} ${plural} ago`;
}
