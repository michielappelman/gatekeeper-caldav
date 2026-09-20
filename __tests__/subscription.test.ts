import { describe, expect, it, vi } from "vitest";
import { fetchIcsFeed, normalizeFeedUrl, type FetchLike } from "../src/caldav-api";
import { CalDavError } from "../src/errors";
import { feedMetadata, splitFeedObjects } from "../src/events";
import { normalizeGrant, SubscriptionStore, type FeedCache, type Grant } from "../src/store";

const FEED_URL = "https://example.com/holidays.ics";

const FEED = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Example//Holidays//EN",
  "X-WR-CALNAME:Dutch holidays",
  "X-WR-TIMEZONE:Europe/Amsterdam",
  "BEGIN:VTIMEZONE",
  "TZID:Europe/Amsterdam",
  "BEGIN:STANDARD",
  "DTSTART:19701025T030000",
  "TZOFFSETFROM:+0200",
  "TZOFFSETTO:+0100",
  "END:STANDARD",
  "END:VTIMEZONE",
  "BEGIN:VEVENT",
  "UID:kingsday@example.com",
  "SUMMARY:King's Day",
  "DTSTART;VALUE=DATE:20260427",
  "DTEND;VALUE=DATE:20260428",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:standup/weekly@example.com",
  "SUMMARY:Public standup",
  "DTSTART;TZID=Europe/Amsterdam:20260406T090000",
  "DTEND;TZID=Europe/Amsterdam:20260406T093000",
  "RRULE:FREQ=WEEKLY;BYDAY=MO",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:standup/weekly@example.com",
  "RECURRENCE-ID;TZID=Europe/Amsterdam:20260413T090000",
  "SUMMARY:Public standup (moved)",
  "DTSTART;TZID=Europe/Amsterdam:20260413T100000",
  "DTEND;TZID=Europe/Amsterdam:20260413T103000",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");

describe("normalizeFeedUrl", () => {
  it("accepts webcal and bare hosts, and rejects insecure or credentialed links", () => {
    expect(normalizeFeedUrl("webcal://example.com/holidays.ics")).toBe(FEED_URL);
    expect(normalizeFeedUrl(" example.com/holidays.ics ")).toBe(FEED_URL);
    expect(() => normalizeFeedUrl("http://example.com/x.ics")).toThrow(CalDavError);
    expect(() => normalizeFeedUrl("https://u:p@example.com/x.ics")).toThrow(CalDavError);
    expect(() => normalizeFeedUrl("not a url")).toThrow(CalDavError);
  });
});

describe("fetchIcsFeed", () => {
  it("sends validators and reports an unchanged feed", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 304 }));
    expect(await fetchIcsFeed(FEED_URL, { etag: "\"v1\"" }, fetchImpl)).toEqual({ status: "notModified" });
    expect((fetchImpl.mock.calls[0][1]!.headers as Record<string, string>)["If-None-Match"]).toBe("\"v1\"");
  });

  it("returns the body with its validators", async () => {
    const fetchImpl: FetchLike = async () => new Response(FEED, {
      headers: { "Content-Type": "text/calendar", ETag: "\"v2\"", "Last-Modified": "Mon, 01 Jun 2026 00:00:00 GMT" },
    });
    expect(await fetchIcsFeed(FEED_URL, {}, fetchImpl)).toEqual({
      status: "ok", text: FEED, etag: "\"v2\"", lastModified: "Mon, 01 Jun 2026 00:00:00 GMT",
    });
  });

  it("rejects a link that is not public, and one that is not a calendar", async () => {
    await expect(fetchIcsFeed(FEED_URL, {}, async () => new Response("", { status: 401 })))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(fetchIcsFeed(FEED_URL, {}, async () => new Response("<html>nope</html>")))
      .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("refuses an oversized feed by its declared length", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(FEED, { headers: { "Content-Length": String(50 * 1024 * 1024) } });
    await expect(fetchIcsFeed(FEED_URL, {}, fetchImpl)).rejects.toMatchObject({ code: "TOO_MANY_EVENTS" });
  });
});

describe("feed parsing", () => {
  it("reads the feed's own name and time zone", () => {
    expect(feedMetadata(FEED)).toEqual({ name: "Dutch holidays", timeZone: "Europe/Amsterdam" });
  });

  it("splits a feed into one object per UID, carrying the VTIMEZONE into each", () => {
    const objects = splitFeedObjects(FEED);
    expect(objects).toHaveLength(2);
    expect(objects.map(object => object.name)).toEqual(["kingsday@example.com", "standup_weekly@example.com"]);
    // The series and its override travel together, so the override still replaces its occurrence.
    expect(objects[1].calendar.components.filter(component => component.name === "VEVENT")).toHaveLength(2);
    for (const object of objects) {
      expect(object.calendar.components.some(component => component.name === "VTIMEZONE")).toBe(true);
    }
  });
});

describe("SubscriptionStore", () => {
  function makeStore(fetchImpl: FetchLike, cache: FeedCache = {}) {
    const grant: Grant = { kind: "ics", url: FEED_URL, name: "Dutch holidays" };
    return { store: new SubscriptionStore({ getGrant: async () => grant }, cache, fetchImpl), cache };
  }

  const okFetch = () => vi.fn(async () => new Response(FEED, { headers: { ETag: "\"v2\"" } }));

  it("reports the feed as one read-only calendar", async () => {
    const { store } = makeStore(okFetch());
    expect(await store.calendar()).toEqual({
      id: "subscription", url: FEED_URL, name: "Dutch holidays", timeZone: "Europe/Amsterdam", readOnly: true,
    });
  });

  it("lists events across the whole feed, expanding series and applying overrides", async () => {
    const { store } = makeStore(okFetch());
    const calendar = await store.calendar();
    const events = await store.listEvents(
      calendar, { startMs: Date.parse("2026-04-01T00:00:00Z"), endMs: Date.parse("2026-04-30T00:00:00Z") }, false);
    expect(events.map(event => event.title)).toEqual([
      "Public standup", "Public standup (moved)", "Public standup", "King's Day", "Public standup",
    ]);
    // Nobody is "self" on someone else's published calendar.
    expect(events.every(event => event.attendees === undefined)).toBe(true);
  });

  it("serves a cached feed without refetching, then revalidates once it goes stale", async () => {
    const fetchImpl = okFetch();
    const { store, cache } = makeStore(fetchImpl);
    await store.calendar();
    await store.calendar();
    expect(fetchImpl).toHaveBeenCalledOnce();

    cache.fetchedAt = Date.now() - 10 * 60_000;
    fetchImpl.mockImplementationOnce(async () => new Response(null, { status: 304 }));
    expect((await store.calendar()).name).toBe("Dutch holidays");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect((fetchImpl.mock.calls[1][1]!.headers as Record<string, string>)["If-None-Match"]).toBe("\"v2\"");
  });

  it("refuses writes", async () => {
    const { store } = makeStore(okFetch());
    await expect(store.currentText()).rejects.toMatchObject({ code: "READ_ONLY" });
    expect(() => store.recordPending()).toThrow(expect.objectContaining({ code: "READ_ONLY" }));
  });

  it("refuses to read a feed through a CalDAV account connection", async () => {
    const grant: Grant = {
      kind: "caldav", serverUrl: "https://caldav.example.com/", username: "u", password: "p",
      homeUrl: "https://caldav.example.com/cal/", addresses: [],
    };
    const store = new SubscriptionStore({ getGrant: async () => grant }, {}, okFetch());
    await expect(store.calendar()).rejects.toMatchObject({ code: "INVALID_RESOURCE" });
  });
});

describe("normalizeGrant", () => {
  it("reads a grant stored before subscriptions existed as a CalDAV account", () => {
    const legacy = {
      serverUrl: "https://caldav.icloud.com/", username: "me@icloud.com", password: "pw",
      homeUrl: "https://p42-caldav.icloud.com/1/calendars/", addresses: ["me@icloud.com"],
    };
    expect(normalizeGrant(legacy)).toEqual({ ...legacy, kind: "caldav" });
  });

  it("leaves a subscription grant alone", () => {
    const grant: Grant = { kind: "ics", url: FEED_URL, name: "Dutch holidays" };
    expect(normalizeGrant(grant)).toBe(grant);
  });
});
