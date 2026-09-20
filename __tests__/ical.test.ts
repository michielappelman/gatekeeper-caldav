import { describe, expect, it } from "vitest";
import {
  escapeText,
  formatMinutesBefore,
  getText,
  parseDateTimeProperty,
  parseDuration,
  parseICalendar,
  serializeICalendar,
  unescapeText,
} from "../src/ical";

const SAMPLE = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Apple Inc.//iCloud//EN",
  "BEGIN:VEVENT",
  "UID:abc",
  "SUMMARY:Dinner\\, drinks\\; more",
  "DESCRIPTION:Line one\\nLine two with a very long tail that definitely needs folding once it gets",
  "  past seventy-five octets",
  "DTSTART;TZID=Europe/Amsterdam:20260920T190000",
  "X-APPLE-TRAVEL-ADVISORY-BEHAVIOR;X-PARAM=\"a:b\":AUTOMATIC",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");

describe("parseICalendar", () => {
  it("unfolds, unescapes, and keeps unknown properties", () => {
    const calendar = parseICalendar(SAMPLE);
    const event = calendar.components[0];
    expect(getText(event, "SUMMARY")).toBe("Dinner, drinks; more");
    expect(getText(event, "DESCRIPTION")).toContain("Line one\nLine two");
    expect(getText(event, "DESCRIPTION")).toContain("gets past seventy-five");
    const unknown = event.properties.find(property => property.name === "X-APPLE-TRAVEL-ADVISORY-BEHAVIOR");
    expect(unknown).toEqual({ name: "X-APPLE-TRAVEL-ADVISORY-BEHAVIOR", params: { "X-PARAM": "a:b" }, value: "AUTOMATIC" });
  });

  it("round-trips through serialize with folding at 75 octets", () => {
    const text = serializeICalendar(parseICalendar(SAMPLE));
    for (const line of text.split("\r\n")) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(serializeICalendar(parseICalendar(text))).toBe(text);
    expect(text).toContain("X-PARAM=\"a:b\"");
  });

  it("rejects unbalanced components", () => {
    expect(() => parseICalendar("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nEND:VCALENDAR")).toThrow();
  });

  it("parses TZID, UTC, and DATE values", () => {
    expect(parseDateTimeProperty({ name: "DTSTART", params: { TZID: "Europe/Amsterdam" }, value: "20260920T190000" }))
      .toEqual({ kind: "dateTime", local: { year: 2026, month: 9, day: 20, hour: 19, minute: 0, second: 0 }, zone: { type: "tz", tzid: "Europe/Amsterdam" } });
    expect(parseDateTimeProperty({ name: "DTSTART", params: {}, value: "20260920T170000Z" }).kind).toBe("dateTime");
    expect(parseDateTimeProperty({ name: "DTSTART", params: { VALUE: "DATE" }, value: "20260920" }))
      .toEqual({ kind: "date", year: 2026, month: 9, day: 20 });
  });
});

describe("text and duration helpers", () => {
  it("escapes and unescapes symmetrically", () => {
    const text = "a,b;c\\d\ne";
    expect(unescapeText(escapeText(text))).toBe(text);
  });

  it("parses and formats durations", () => {
    expect(parseDuration("-PT15M")).toBe(-15 * 60_000);
    expect(parseDuration("P1DT2H")).toBe((24 + 2) * 3_600_000);
    expect(parseDuration("P1W")).toBe(7 * 86_400_000);
    expect(parseDuration("garbage")).toBeUndefined();
    expect(formatMinutesBefore(15)).toBe("-PT15M");
    expect(formatMinutesBefore(0)).toBe("PT0S");
    expect(formatMinutesBefore(1440 + 90)).toBe("-P1DT1H30M");
  });
});
