import { describe, expect, it } from "vitest";
import { describeWhen, parseWhen } from "./time";

describe("parseWhen", () => {
  const now = 1_700_000_000_000;

  it("reads relative offsets", () => {
    expect(parseWhen("+30s", now)).toBe(now + 30_000);
    expect(parseWhen("+5m", now)).toBe(now + 300_000);
    expect(parseWhen("+2h", now)).toBe(now + 7_200_000);
    expect(parseWhen("+1d", now)).toBe(now + 86_400_000);
    expect(parseWhen("  +5M  ", now)).toBe(now + 300_000);
  });

  it("reads ISO-8601 timestamps", () => {
    expect(parseWhen("2026-08-12T09:00:00.000Z", now)).toBe(
      Date.parse("2026-08-12T09:00:00.000Z"),
    );
  });

  it("refuses what it cannot parse", () => {
    expect(parseWhen("", now)).toBeNull();
    expect(parseWhen("soon", now)).toBeNull();
    expect(parseWhen("+5y", now)).toBeNull();
    expect(parseWhen("5m", now)).toBeNull();
  });
});

describe("describeWhen", () => {
  const now = 1_700_000_000_000;

  it("describes both directions with coarse units", () => {
    expect(describeWhen(now + 45_000, now)).toBe("in 45 seconds");
    expect(describeWhen(now + 60_000, now)).toBe("in 1 minute");
    expect(describeWhen(now + 7_200_000, now)).toBe("in 2 hours");
    expect(describeWhen(now - 172_800_000, now)).toBe("2 days ago");
  });
});
