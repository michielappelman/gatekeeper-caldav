import { describe, expect, it, vi } from "vitest";
import type { FetchLike } from "../src/caldav-api";
import { buildEventObject } from "../src/events";
import { CalendarStore, getPending, listPending, type CacheKv, type Grant } from "../src/store";

function makeKv(): CacheKv {
  const store = new Map<string, unknown>();
  return {
    get: <T>(key: string) => structuredClone(store.get(key)) as T | undefined,
    put: <T>(key: string, value: T) => void store.set(key, structuredClone(value)),
    delete: (key: string) => store.delete(key),
  };
}

const HOME = "https://caldav.example.com/cal/";
const CALENDAR_URL = `${HOME}home/`;
const GRANT: Grant = {
  serverUrl: "https://caldav.example.com/", username: "me", password: "pw", homeUrl: HOME, addresses: [],
};
const WINDOW = { startMs: Date.parse("2026-09-01T00:00:00Z"), endMs: Date.parse("2026-10-01T00:00:00Z") };

const EXISTING = [
  "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//t//EN", "BEGIN:VEVENT", "UID:e1", "SUMMARY:Lunch",
  "DTSTART:20260915T110000Z", "DTEND:20260915T120000Z", "END:VEVENT", "END:VCALENDAR", "",
].join("\r\n");

/** A tiny in-memory CalDAV server holding one calendar. */
function fakeServer() {
  const objects = new Map<string, { data: string; etag: number }>([["e1.ics", { data: EXISTING, etag: 1 }]]);
  const writes: { method: string; name: string; headers: Record<string, string> }[] = [];
  let conflictsLeft = 0;
  const fetchImpl: FetchLike = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (method === "PROPFIND") {
      return new Response(`<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">` +
        `<d:response><d:href>/cal/home/</d:href><d:propstat><d:prop><d:resourcetype><c:calendar/></d:resourcetype>` +
        `<d:displayname>Home</d:displayname></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>` +
        `</d:multistatus>`, { status: 207 });
    }
    if (method === "REPORT") {
      const body = [...objects].map(([name, object]) =>
        `<d:response><d:href>/cal/home/${name}</d:href><d:propstat><d:prop><d:getetag>"${object.etag}"</d:getetag>` +
        `<c:calendar-data><![CDATA[${object.data}]]></c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join("");
      return new Response(`<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${body}</d:multistatus>`, { status: 207 });
    }
    const name = url.slice(CALENDAR_URL.length);
    const object = objects.get(name);
    if (method === "GET") {
      return object ? new Response(object.data, { headers: { ETag: `"${object.etag}"` } }) : new Response("", { status: 404 });
    }
    writes.push({ method, name, headers });
    if (conflictsLeft > 0) {
      conflictsLeft--;
      if (object) object.etag++; // someone else edited it
      return new Response("", { status: 412 });
    }
    if (method === "PUT") {
      if (headers["If-None-Match"] === "*" && object) return new Response("", { status: 412 });
      if (headers["If-Match"] && (!object || headers["If-Match"] !== `"${object.etag}"`)) return new Response("", { status: 412 });
      objects.set(name, { data: String(init?.body), etag: (object?.etag ?? 0) + 1 });
      return new Response(null, { status: 201 });
    }
    if (method === "DELETE") {
      objects.delete(name);
      return new Response(null, { status: 204 });
    }
    return new Response("", { status: 405 });
  });
  return { objects, writes, fetchImpl, conflictOnce: () => { conflictsLeft = 1; } };
}

function makeStore(server: ReturnType<typeof fakeServer>, kv = makeKv()) {
  const account = { getGrant: async () => GRANT, noteCredentialsExpired: vi.fn(async () => {}) };
  return { store: new CalendarStore(account, kv, () => {}, server.fetchImpl), kv, account };
}

describe("CalendarStore", () => {
  it("shows pending creates, updates, and deletes before they are applied", async () => {
    const server = fakeServer();
    const { store } = makeStore(server);
    const calendar = await store.calendar("home");
    const context = await store.context(calendar);

    const ics = buildEventObject({
      title: "Swim",
      start: { kind: "dateTime", dateTime: new Date("2026-09-20T08:00:00Z") },
      end: { kind: "dateTime", dateTime: new Date("2026-09-20T09:00:00Z") },
    }, "new", context, Date.now());
    store.recordPending(calendar, "new.ics", { kind: "create", objectName: "new.ics", ics });
    store.recordPending(calendar, "e1.ics", { kind: "update", target: { objectName: "e1.ics" }, now: 0, patch: { title: "Long lunch" } });
    store.recordPending(calendar, "new.ics", { kind: "update", target: { objectName: "new.ics" }, now: 0, patch: { location: "Pool" } });

    const events = await store.listEvents(calendar, WINDOW, false);
    expect(events.map(event => [event.id, event.title, event.location])).toEqual([
      ["e1.ics", "Long lunch", undefined],
      ["new.ics", "Swim", "Pool"],
    ]);
    // Nothing was written yet.
    expect(server.writes).toEqual([]);

    const deleteId = store.recordPending(calendar, "e1.ics", { kind: "delete", target: { objectName: "e1.ics" }, now: 0 });
    expect((await store.listEvents(calendar, WINDOW, false)).map(event => event.id)).toEqual(["new.ics"]);
    store.reject(deleteId);
    expect((await store.listEvents(calendar, WINDOW, false)).map(event => event.id)).toEqual(["e1.ics", "new.ics"]);
  });

  it("applies a create with If-None-Match and clears the journal entry", async () => {
    const server = fakeServer();
    const { store, kv } = makeStore(server);
    const calendar = await store.calendar("home");
    const ics = buildEventObject({
      title: "Swim",
      start: { kind: "dateTime", dateTime: new Date("2026-09-20T08:00:00Z") },
      end: { kind: "dateTime", dateTime: new Date("2026-09-20T09:00:00Z") },
    }, "new", await store.context(calendar), Date.now());
    const actionId = store.recordPending(calendar, "new.ics", { kind: "create", objectName: "new.ics", ics });
    await store.apply(actionId);
    expect(server.writes).toEqual([{ method: "PUT", name: "new.ics", headers: expect.objectContaining({ "If-None-Match": "*" }) }]);
    expect(server.objects.get("new.ics")?.data).toBe(ics);
    expect(getPending(kv, actionId)).toBeUndefined();
    expect(listPending(kv, "home")).toEqual([]);
  });

  it("applies an update onto the server's current copy, retrying once after a concurrent edit", async () => {
    const server = fakeServer();
    const { store } = makeStore(server);
    const calendar = await store.calendar("home");
    const actionId = store.recordPending(calendar, "e1.ics", {
      kind: "update", target: { objectName: "e1.ics" }, now: 0, patch: { location: "Cafe" },
    });
    server.conflictOnce();
    await store.apply(actionId);
    expect(server.writes.map(write => write.headers["If-Match"])).toEqual(["\"1\"", "\"2\""]);
    expect(server.objects.get("e1.ics")?.data).toContain("LOCATION:Cafe");
  });

  it("keeps a failed apply pending and explains an out-of-order approval", async () => {
    const server = fakeServer();
    const { store, kv } = makeStore(server);
    const calendar = await store.calendar("home");
    const context = await store.context(calendar);
    const ics = buildEventObject({
      title: "Swim",
      start: { kind: "dateTime", dateTime: new Date("2026-09-20T08:00:00Z") },
      end: { kind: "dateTime", dateTime: new Date("2026-09-20T09:00:00Z") },
    }, "new", context, Date.now());
    store.recordPending(calendar, "new.ics", { kind: "create", objectName: "new.ics", ics });
    const updateId = store.recordPending(calendar, "new.ics", {
      kind: "update", target: { objectName: "new.ics" }, now: 0, patch: { title: "Swim!" },
    });
    await expect(store.apply(updateId)).rejects.toThrow(/Approve its creation first/);
    expect(getPending(kv, updateId)).toBeDefined();
  });

  it("treats deleting an already-deleted event as done", async () => {
    const server = fakeServer();
    const { store } = makeStore(server);
    const calendar = await store.calendar("home");
    const actionId = store.recordPending(calendar, "gone.ics", { kind: "delete", target: { objectName: "gone.ics" }, now: 0 });
    await expect(store.apply(actionId)).resolves.toBeUndefined();
  });

  it("reports rejected credentials to the account", async () => {
    const server = fakeServer();
    const failing: FetchLike = async () => new Response("", { status: 401 });
    const { account } = makeStore(server);
    const store = new CalendarStore(account, makeKv(), () => {}, failing);
    await expect(store.calendars()).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
    expect(account.noteCredentialsExpired).toHaveBeenCalledOnce();
  });
});
