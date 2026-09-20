import { describe, expect, it } from "vitest";
import { CalDavError } from "../src/errors";
import {
  CALDAV_ACCOUNT_RESOURCE,
  CALDAV_CALENDAR_RESOURCE,
  parseResourceUrl,
  toAccountResourceUrl,
  toCalendarResourceUrl,
} from "../src/resource";

describe("resource", () => {
  it("round-trips both resource URLs and matches their patterns", () => {
    expect(parseResourceUrl(toAccountResourceUrl())).toEqual({ kind: "account" });
    const url = toCalendarResourceUrl("shared one");
    expect(url).toBe("https://caldav.local/calendar/shared%20one");
    expect(parseResourceUrl(url)).toEqual({ kind: "calendar", calendarId: "shared one" });
    expect(new URLPattern(CALDAV_ACCOUNT_RESOURCE.urlPattern).test(toAccountResourceUrl())).toBe(true);
    expect(new URLPattern(CALDAV_CALENDAR_RESOURCE.urlPattern).test(url)).toBe(true);
    expect(new URLPattern(CALDAV_CALENDAR_RESOURCE.urlPattern).test(toAccountResourceUrl())).toBe(false);
  });

  it("rejects foreign hosts, extra paths, queries, hashes, and slashes in ids", () => {
    for (const url of [
      "https://evil.example/account",
      "https://caldav.local/calendar/a/b",
      "https://caldav.local/calendar/a%2Fb",
      "https://caldav.local/account?x=1",
      "https://caldav.local/account#x",
      "https://caldav.local/calendar/",
      "not a url",
    ]) {
      expect(() => parseResourceUrl(url), url).toThrow(CalDavError);
    }
  });
});
