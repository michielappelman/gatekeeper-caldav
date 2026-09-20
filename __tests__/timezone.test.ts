import { describe, expect, it } from "vitest";
import { buildVTimezone, describeNow, normalizeTzid, utcToZoned, zonedToUtc } from "../src/timezone";

describe("zonedToUtc / utcToZoned", () => {
  it("converts summer and winter wall times in Europe/Amsterdam", () => {
    expect(new Date(zonedToUtc({ year: 2026, month: 7, day: 1, hour: 9, minute: 0, second: 0 }, "Europe/Amsterdam"))
      .toISOString()).toBe("2026-07-01T07:00:00.000Z");
    expect(new Date(zonedToUtc({ year: 2026, month: 12, day: 1, hour: 9, minute: 0, second: 0 }, "Europe/Amsterdam"))
      .toISOString()).toBe("2026-12-01T08:00:00.000Z");
  });

  it("round-trips", () => {
    const at = Date.parse("2026-03-29T00:30:00Z");
    expect(zonedToUtc(utcToZoned(at, "America/New_York"), "America/New_York")).toBe(at);
  });

  it("resolves a wall time skipped by DST to just after the jump", () => {
    // 02:30 does not exist on 2026-03-29 in Amsterdam (02:00 -> 03:00).
    const ms = zonedToUtc({ year: 2026, month: 3, day: 29, hour: 2, minute: 30, second: 0 }, "Europe/Amsterdam");
    expect(new Date(ms).toISOString()).toBe("2026-03-29T01:30:00.000Z");
  });
});

describe("normalizeTzid", () => {
  it("accepts IANA, prefixed, and Windows names", () => {
    expect(normalizeTzid("Europe/Amsterdam")).toBe("Europe/Amsterdam");
    expect(normalizeTzid("/mozilla.org/20050126_1/Europe/Berlin")).toBe("Europe/Berlin");
    expect(normalizeTzid("W. Europe Standard Time")).toBe("Europe/Berlin");
    expect(normalizeTzid("Not/AZone")).toBeUndefined();
  });
});

describe("buildVTimezone", () => {
  it("describes European DST as last-Sunday rules", () => {
    const text = buildVTimezone("Europe/Amsterdam", 2026).join("\n");
    expect(text).toContain("TZID:Europe/Amsterdam");
    expect(text).toContain("RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU");
    expect(text).toContain("RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU");
    expect(text).toContain("DTSTART:19700329T020000");
    expect(text).toContain("TZOFFSETTO:+0200");
  });

  it("emits a single fixed-offset observance for zones without DST", () => {
    const lines = buildVTimezone("Asia/Tokyo", 2026);
    expect(lines.filter(line => line === "BEGIN:STANDARD")).toHaveLength(1);
    expect(lines).toContain("TZOFFSETTO:+0900");
  });
});

describe("describeNow", () => {
  it("reports the date, weekday, and offset as the calendar's zone sees them", () => {
    // 00:30 UTC on a Sunday is already Sunday 02:30 in Amsterdam (summer time).
    const at = Date.parse("2026-07-05T00:30:00Z");
    expect(describeNow(at, "Europe/Amsterdam")).toEqual({
      now: new Date(at),
      timeZone: "Europe/Amsterdam",
      today: "2026-07-05",
      localTime: "2026-07-05T02:30:00",
      weekday: "Sunday",
      utcOffset: "+02:00",
    });
  });

  it("reports the previous local day when the zone is behind UTC", () => {
    const at = Date.parse("2026-01-05T02:00:00Z");
    expect(describeNow(at, "America/New_York")).toMatchObject({
      today: "2026-01-04", localTime: "2026-01-04T21:00:00", weekday: "Sunday", utcOffset: "-05:00",
    });
  });

  it("handles a half-hour offset", () => {
    expect(describeNow(Date.parse("2026-07-05T00:30:00Z"), "Asia/Kolkata").utcOffset).toBe("+05:30");
  });
});
