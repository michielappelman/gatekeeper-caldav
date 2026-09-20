import { describe, expect, it, vi } from "vitest";
import {
  deleteObject,
  discoverAccount,
  getObject,
  listCalendars,
  normalizeServerUrl,
  objectNameFromHref,
  putObject,
  queryObjects,
  type FetchLike,
} from "../src/caldav-api";
import { CalDavError } from "../src/errors";
import { parseXml } from "../src/xml";

const CREDS = { username: "me@icloud.com", password: "abcd-efgh-ijkl-mnop" };
const HOME = "https://p42-caldav.icloud.com/1234/calendars/";

function multistatus(body: string, status = 207): Response {
  return new Response(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" ` +
    `xmlns:a="http://apple.com/ns/ical/">${body}</d:multistatus>`, { status, headers: { "Content-Type": "application/xml" } });
}

type Call = { url: string; init: RequestInit };

function mockFetch(handler: (call: Call) => Response): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const call = { url, init: init ?? {} };
    calls.push(call);
    return handler(call);
  });
  return { fetchImpl, calls };
}

describe("normalizeServerUrl", () => {
  it("adds https and rejects insecure or credentialed URLs", () => {
    expect(normalizeServerUrl("caldav.icloud.com")).toBe("https://caldav.icloud.com/");
    expect(() => normalizeServerUrl("http://caldav.example.com")).toThrow(CalDavError);
    expect(() => normalizeServerUrl("https://u:p@caldav.example.com")).toThrow(CalDavError);
  });
});

describe("discoverAccount", () => {
  it("follows current-user-principal to the calendar home, as iCloud serves it", async () => {
    const { fetchImpl, calls } = mockFetch(({ url }) => {
      if (url === "https://caldav.icloud.com/") {
        return multistatus(`<d:response><d:href>/</d:href><d:propstat><d:prop><d:current-user-principal>` +
          `<d:href>/1234/principal/</d:href></d:current-user-principal></d:prop>` +
          `<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`);
      }
      if (url === "https://caldav.icloud.com/1234/principal/") {
        return multistatus(`<d:response><d:href>/1234/principal/</d:href><d:propstat><d:prop>` +
          `<c:calendar-home-set><d:href>https://p42-caldav.icloud.com:443/1234/calendars</d:href></c:calendar-home-set>` +
          `<c:calendar-user-address-set><d:href>mailto:Me@iCloud.com</d:href><d:href>/1234/principal/</d:href></c:calendar-user-address-set>` +
          `<d:displayname>Me</d:displayname></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`);
      }
      return new Response("", { status: 404 });
    });
    const info = await discoverAccount("https://caldav.icloud.com/", CREDS, fetchImpl);
    expect(info).toEqual({ homeUrl: HOME, addresses: ["me@icloud.com"], displayName: "Me" });
    expect(calls[0].init.method).toBe("PROPFIND");
    expect((calls[0].init.headers as Record<string, string>).Authorization)
      .toBe(`Basic ${btoa("me@icloud.com:abcd-efgh-ijkl-mnop")}`);
    expect(calls[0].init.redirect).toBe("manual");
  });

  it("maps a 401 to AUTH_EXPIRED without trying further", async () => {
    const { fetchImpl, calls } = mockFetch(() => new Response("", { status: 401 }));
    await expect(discoverAccount("https://caldav.icloud.com/", CREDS, fetchImpl))
      .rejects.toMatchObject({ code: "AUTH_EXPIRED" });
    expect(calls).toHaveLength(1);
  });

  it("follows https redirects but refuses to send credentials over http", async () => {
    const { fetchImpl } = mockFetch(() => new Response(null, { status: 301, headers: { Location: "http://evil.example/" } }));
    await expect(discoverAccount("https://caldav.example.com/", CREDS, fetchImpl))
      .rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
  });
});

describe("listCalendars", () => {
  it("keeps event calendars inside the home, with their metadata", async () => {
    const { fetchImpl, calls } = mockFetch(() => multistatus(
      `<d:response><d:href>/1234/calendars/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>` +
      `<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>` +
      `<d:response><d:href>/1234/calendars/home/</d:href><d:propstat><d:prop>` +
      `<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Family</d:displayname>` +
      `<a:calendar-color>#FF2968FF</a:calendar-color>` +
      `<c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>` +
      `<c:calendar-timezone><![CDATA[BEGIN:VCALENDAR\r\nBEGIN:VTIMEZONE\r\nTZID:Europe/Amsterdam\r\nEND:VTIMEZONE\r\nEND:VCALENDAR]]></c:calendar-timezone>` +
      `<d:current-user-privilege-set><d:privilege><d:read/></d:privilege><d:privilege><d:write/></d:privilege></d:current-user-privilege-set>` +
      `</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>` +
      `<d:propstat><d:prop><c:calendar-description/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>` +
      `<d:response><d:href>/1234/calendars/tasks/</d:href><d:propstat><d:prop>` +
      `<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Reminders</d:displayname>` +
      `<c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set>` +
      `</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>` +
      `<d:response><d:href>/1234/calendars/shared%20one/</d:href><d:propstat><d:prop>` +
      `<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Shared</d:displayname>` +
      `<d:current-user-privilege-set><d:privilege><d:read/></d:privilege></d:current-user-privilege-set>` +
      `</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>` +
      `<d:response><d:href>https://elsewhere.example/1234/calendars/x/</d:href><d:propstat><d:prop>` +
      `<d:resourcetype><c:calendar/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`));
    const calendars = await listCalendars(HOME, CREDS, fetchImpl);
    expect(calendars).toEqual([
      {
        id: "home", url: `${HOME}home/`, name: "Family", color: "#ff2968", description: undefined,
        timeZone: "Europe/Amsterdam", readOnly: false,
      },
      {
        id: "shared one", url: `${HOME}shared%20one/`, name: "Shared", color: undefined, description: undefined,
        timeZone: undefined, readOnly: true,
      },
    ]);
    expect((calls[0].init.headers as Record<string, string>).Depth).toBe("1");
  });
});

describe("calendar objects", () => {
  const CALENDAR = `${HOME}home/`;

  it("queries a time range and keeps only objects directly inside the calendar", async () => {
    const { fetchImpl, calls } = mockFetch(() => multistatus(
      `<d:response><d:href>/1234/calendars/home/a.ics</d:href><d:propstat><d:prop><d:getetag>"1"</d:getetag>` +
      `<c:calendar-data>BEGIN:VCALENDAR&#13;\nEND:VCALENDAR</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>` +
      `<d:response><d:href>/1234/calendars/other/b.ics</d:href><d:propstat><d:prop><d:getetag>"2"</d:getetag>` +
      `<c:calendar-data>BEGIN:VCALENDAR</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`));
    const objects = await queryObjects(CALENDAR, Date.parse("2026-09-01T00:00:00Z"), Date.parse("2026-10-01T00:00:00Z"), CREDS, fetchImpl);
    expect(objects).toEqual([{ name: "a.ics", etag: "\"1\"", data: "BEGIN:VCALENDAR\r\nEND:VCALENDAR" }]);
    expect(calls[0].init.method).toBe("REPORT");
    expect(calls[0].init.body).toContain(`<c:time-range start="20260901T000000Z" end="20261001T000000Z"/>`);
  });

  it("gets, puts conditionally, and treats a missing object as deleted", async () => {
    const { fetchImpl, calls } = mockFetch(({ init }) => {
      if (init.method === "GET") return new Response("", { status: 404 });
      if (init.method === "PUT") return new Response(null, { status: 201 });
      return new Response(null, { status: 404 });
    });
    expect(await getObject(`${CALENDAR}a.ics`, CREDS, fetchImpl)).toBeNull();
    await putObject(`${CALENDAR}a.ics`, "DATA", { create: true }, CREDS, fetchImpl);
    await putObject(`${CALENDAR}a.ics`, "DATA", { ifMatch: "\"1\"" }, CREDS, fetchImpl);
    await deleteObject(`${CALENDAR}a.ics`, "\"1\"", CREDS, fetchImpl);
    expect((calls[1].init.headers as Record<string, string>)["If-None-Match"]).toBe("*");
    expect((calls[2].init.headers as Record<string, string>)["If-Match"]).toBe("\"1\"");
    expect((calls[3].init.headers as Record<string, string>)["If-Match"]).toBe("\"1\"");
  });

  it("surfaces a failed precondition as CONFLICT", async () => {
    const { fetchImpl } = mockFetch(() => new Response("", { status: 412 }));
    await expect(putObject(`${CALENDAR}a.ics`, "DATA", { ifMatch: "\"1\"" }, CREDS, fetchImpl))
      .rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("derives resource names only for direct children", () => {
    expect(objectNameFromHref("/1234/calendars/home/a.ics", CALENDAR)).toBe("a.ics");
    expect(objectNameFromHref("/1234/calendars/home/sub/a.ics", CALENDAR)).toBeUndefined();
    expect(objectNameFromHref("https://other.example/1234/calendars/home/a.ics", CALENDAR)).toBeUndefined();
    expect(objectNameFromHref("/1234/calendars/home/", CALENDAR)).toBeUndefined();
  });
});

describe("parseXml", () => {
  it("resolves namespace prefixes and rejects DTDs", () => {
    const root = parseXml(`<x:a xmlns:x="DAV:"><y:b xmlns:y="urn:y" n="1">t&amp;u</y:b></x:a>`);
    expect(root).toMatchObject({ ns: "DAV:", name: "a" });
    expect(root.children[0]).toMatchObject({ ns: "urn:y", name: "b", attrs: { n: "1" }, text: "t&u" });
    expect(() => parseXml(`<!DOCTYPE x [<!ENTITY a "b">]><x/>`)).toThrow(CalDavError);
  });
});
