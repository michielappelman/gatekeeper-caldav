import { describe, expect, it } from "vitest";
import { CalDavError } from "../src/errors";
import {
  applyOp,
  buildEventObject,
  eventsInWindow,
  parseEventId,
  type CalendarContext,
} from "../src/events";
import { parseICalendar } from "../src/ical";
import type { CalDavEvent } from "../src/types";

const CONTEXT: CalendarContext = { calendarId: "home", defaultTz: "Europe/Amsterdam", selfAddresses: ["me@icloud.com"] };
const NOW = Date.parse("2026-09-19T12:00:00Z");

function ics(...eventLines: string[][]): string {
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN",
    ...eventLines.flatMap(lines => ["BEGIN:VEVENT", ...lines, "END:VEVENT"]),
    "END:VCALENDAR", "",
  ].join("\r\n");
}

function window(start: string, end: string) {
  return { startMs: Date.parse(start), endMs: Date.parse(end) };
}

function list(text: string, start: string, end: string, includeDescriptions = false): CalDavEvent[] {
  return eventsInWindow("obj.ics", text, CONTEXT, window(start, end), includeDescriptions);
}

const WEEKLY = ics([
  "UID:weekly", "SUMMARY:Standup", "DTSTART;TZID=Europe/Amsterdam:20260302T090000",
  "DTEND;TZID=Europe/Amsterdam:20260302T091500", "RRULE:FREQ=WEEKLY;BYDAY=MO", "DESCRIPTION:Agenda",
]);

describe("eventsInWindow", () => {
  it("returns a one-off event with its fields", () => {
    const text = ics([
      "UID:one", "SUMMARY:Dentist", "DTSTART:20260921T080000Z", "DTEND:20260921T090000Z",
      "LOCATION:Main St 1", "DESCRIPTION:Bring card", "TRANSP:TRANSPARENT", "STATUS:TENTATIVE",
      "URL;VALUE=URI:https://example.com/x",
      "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-PT30M", "END:VALARM",
    ]);
    const [event] = list(text, "2026-09-20T00:00:00Z", "2026-09-27T00:00:00Z", true);
    expect(event).toMatchObject({
      id: "obj.ics", calendarId: "home", title: "Dentist", location: "Main St 1", description: "Bring card",
      busy: false, status: "tentative", url: "https://example.com/x", alerts: [{ minutesBefore: 30 }],
      start: { kind: "dateTime", dateTime: new Date("2026-09-21T08:00:00Z") },
    });
    expect(event.seriesId).toBeUndefined();
  });

  it("omits descriptions unless requested", () => {
    expect(list(WEEKLY, "2026-03-01T00:00:00Z", "2026-03-08T00:00:00Z")[0].description).toBeUndefined();
  });

  it("expands a weekly series in wall-clock time across a DST change", () => {
    const events = list(WEEKLY, "2026-03-20T00:00:00Z", "2026-04-07T00:00:00Z");
    expect(events.map(event => event.id)).toEqual([
      "obj.ics/20260323T080000Z", "obj.ics/20260330T070000Z", "obj.ics/20260406T070000Z",
    ]);
    expect(events.every(event => event.seriesId === "obj.ics")).toBe(true);
    expect(events[0].start).toEqual({ kind: "dateTime", dateTime: new Date("2026-03-23T08:00:00Z"), timeZone: "Europe/Amsterdam" });
    expect(events[1].start).toEqual({ kind: "dateTime", dateTime: new Date("2026-03-30T07:00:00Z"), timeZone: "Europe/Amsterdam" });
    expect(events[0].repeats).toBe("Weekly on Monday");
  });

  it("applies EXDATEs and RECURRENCE-ID overrides", () => {
    const text = ics(
      ["UID:w", "SUMMARY:Standup", "DTSTART;TZID=Europe/Amsterdam:20260302T090000",
        "DTEND;TZID=Europe/Amsterdam:20260302T091500", "RRULE:FREQ=WEEKLY;BYDAY=MO",
        "EXDATE;TZID=Europe/Amsterdam:20260309T090000"],
      ["UID:w", "RECURRENCE-ID;TZID=Europe/Amsterdam:20260316T090000", "SUMMARY:Standup (moved)",
        "DTSTART;TZID=Europe/Amsterdam:20260317T100000", "DTEND;TZID=Europe/Amsterdam:20260317T101500"],
    );
    const events = list(text, "2026-03-01T00:00:00Z", "2026-03-24T00:00:00Z");
    expect(events.map(event => [event.id, event.title])).toEqual([
      ["obj.ics/20260302T080000Z", "Standup"],
      ["obj.ics/20260316T080000Z", "Standup (moved)"],
      ["obj.ics/20260323T080000Z", "Standup"],
    ]);
  });

  it("honours COUNT and UNTIL", () => {
    const counted = ics(["UID:c", "SUMMARY:x", "DTSTART:20260901T100000Z", "DTEND:20260901T110000Z", "RRULE:FREQ=DAILY;COUNT=3"]);
    expect(list(counted, "2026-08-01T00:00:00Z", "2026-10-01T00:00:00Z")).toHaveLength(3);
    const until = ics(["UID:u", "SUMMARY:x", "DTSTART:20260901T100000Z", "DTEND:20260901T110000Z", "RRULE:FREQ=DAILY;UNTIL=20260905T100000Z"]);
    expect(list(until, "2026-08-01T00:00:00Z", "2026-10-01T00:00:00Z")).toHaveLength(5);
  });

  it("expands monthly last-Friday and yearly all-day rules", () => {
    const monthly = ics(["UID:m", "SUMMARY:Drinks", "DTSTART:20260130T170000Z", "DTEND:20260130T180000Z", "RRULE:FREQ=MONTHLY;BYDAY=-1FR"]);
    expect(list(monthly, "2026-02-01T00:00:00Z", "2026-05-01T00:00:00Z").map(event => event.id))
      .toEqual(["obj.ics/20260227T170000Z", "obj.ics/20260327T170000Z", "obj.ics/20260424T170000Z"]);
    const birthday = ics(["UID:b", "SUMMARY:Birthday", "DTSTART;VALUE=DATE:20100412", "DTEND;VALUE=DATE:20100413", "RRULE:FREQ=YEARLY"]);
    const [event] = list(birthday, "2026-04-01T00:00:00Z", "2026-05-01T00:00:00Z");
    expect(event).toMatchObject({ id: "obj.ics/20260412", start: { kind: "date", date: "2026-04-12" }, end: { kind: "date", date: "2026-04-13" } });
  });

  it("shows only the first occurrence of an unsupported rule, and says so", () => {
    const text = ics(["UID:s", "SUMMARY:x", "DTSTART:20260901T100000Z", "DTEND:20260901T110000Z", "RRULE:FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1"]);
    const events = list(text, "2026-08-01T00:00:00Z", "2026-12-01T00:00:00Z");
    expect(events).toHaveLength(1);
    expect(events[0].repeats).toContain("irregular");
  });

  it("reports attendees and marks the connected account", () => {
    const text = ics(["UID:i", "SUMMARY:Invite", "DTSTART:20260921T080000Z", "DTEND:20260921T090000Z",
      "ORGANIZER;CN=Boss:mailto:boss@example.com",
      "ATTENDEE;CN=Me;PARTSTAT=ACCEPTED:mailto:me@icloud.com", "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:x@example.com"]);
    const [event] = list(text, "2026-09-20T00:00:00Z", "2026-09-22T00:00:00Z");
    expect(event.organizer).toBe("boss@example.com");
    expect(event.attendees).toEqual([
      { email: "me@icloud.com", name: "Me", status: "accepted", self: true },
      { email: "x@example.com", name: undefined, status: "needsAction", self: undefined },
    ]);
  });
});

describe("parseEventId", () => {
  it("accepts resource names and occurrence keys", () => {
    expect(parseEventId("abc.ics")).toEqual({ objectName: "abc.ics", occurrence: undefined });
    expect(parseEventId("abc.ics/20260302T080000Z")).toEqual({ objectName: "abc.ics", occurrence: "20260302T080000Z" });
    expect(parseEventId("abc.ics/20260412")).toEqual({ objectName: "abc.ics", occurrence: "20260412" });
  });

  it("rejects anything that could address outside the calendar", () => {
    for (const id of ["..", "../x.ics", "a%2Fb.ics", "a.ics/../../x", "a.ics/2026", "", "a b.ics"]) {
      expect(() => parseEventId(id), id).toThrow(CalDavError);
    }
  });
});

describe("applyOp", () => {
  it("creates, and refuses to overwrite", () => {
    expect(applyOp(null, { kind: "create", objectName: "n.ics", ics: "X" }, CONTEXT)).toBe("X");
    expect(() => applyOp("Y", { kind: "create", objectName: "n.ics", ics: "X" }, CONTEXT)).toThrow(CalDavError);
  });

  it("updates a whole series, keeping the duration when only start moves", () => {
    const next = applyOp(WEEKLY, {
      kind: "update", target: { objectName: "obj.ics" }, now: NOW,
      patch: { title: "Daily sync", start: { kind: "dateTime", dateTime: new Date("2026-03-02T09:00:00Z"), timeZone: "Europe/Amsterdam" } },
    }, CONTEXT)!;
    const events = list(next, "2026-03-01T00:00:00Z", "2026-03-10T00:00:00Z");
    expect(events.map(event => [event.title, event.start.kind === "dateTime" && event.start.dateTime.toISOString(),
      event.end.kind === "dateTime" && event.end.dateTime.toISOString()])).toEqual([
      ["Daily sync", "2026-03-02T09:00:00.000Z", "2026-03-02T09:15:00.000Z"],
      ["Daily sync", "2026-03-09T09:00:00.000Z", "2026-03-09T09:15:00.000Z"],
    ]);
    expect(next).toContain("SEQUENCE:1");
  });

  it("updates one occurrence by adding an override", () => {
    const next = applyOp(WEEKLY, {
      kind: "update", target: { objectName: "obj.ics", occurrence: "20260309T080000Z" }, now: NOW,
      patch: { title: "Standup (skip-level)", location: "Room 2" },
    }, CONTEXT)!;
    const events = list(next, "2026-03-01T00:00:00Z", "2026-03-17T00:00:00Z");
    expect(events.map(event => event.title)).toEqual(["Standup", "Standup (skip-level)", "Standup"]);
    expect(events[1]).toMatchObject({ id: "obj.ics/20260309T080000Z", seriesId: "obj.ics", location: "Room 2" });
    // Updating the same occurrence again edits the existing override.
    const again = applyOp(next, {
      kind: "update", target: { objectName: "obj.ics", occurrence: "20260309T080000Z" }, now: NOW, patch: { location: null },
    }, CONTEXT)!;
    expect(parseICalendar(again).components.filter(component => component.name === "VEVENT")).toHaveLength(2);
    expect(list(again, "2026-03-08T00:00:00Z", "2026-03-10T00:00:00Z")[0].location).toBeUndefined();
  });

  it("deletes one occurrence with an EXDATE, or the whole series", () => {
    const next = applyOp(WEEKLY, { kind: "delete", target: { objectName: "obj.ics", occurrence: "20260309T080000Z" }, now: NOW }, CONTEXT)!;
    expect(list(next, "2026-03-01T00:00:00Z", "2026-03-17T00:00:00Z").map(event => event.id))
      .toEqual(["obj.ics/20260302T080000Z", "obj.ics/20260316T080000Z"]);
    expect(applyOp(WEEKLY, { kind: "delete", target: { objectName: "obj.ics" }, now: NOW }, CONTEXT)).toBeNull();
  });

  it("rejects occurrences that do not exist", () => {
    expect(() => applyOp(WEEKLY, { kind: "delete", target: { objectName: "obj.ics", occurrence: "20260310T080000Z" }, now: NOW }, CONTEXT))
      .toThrow(/does not exist/);
    expect(() => applyOp(null, { kind: "delete", target: { objectName: "obj.ics" }, now: NOW }, CONTEXT)).toThrow(CalDavError);
  });

  it("refuses to change or delete invitations", () => {
    const invite = ics(["UID:i", "SUMMARY:Invite", "DTSTART:20260921T080000Z", "DTEND:20260921T090000Z", "ATTENDEE:mailto:x@example.com"]);
    expect(() => applyOp(invite, { kind: "update", target: { objectName: "obj.ics" }, now: NOW, patch: { title: "x" } }, CONTEXT))
      .toThrow(expect.objectContaining({ code: "READ_ONLY" }));
    expect(() => applyOp(invite, { kind: "delete", target: { objectName: "obj.ics" }, now: NOW }, CONTEXT))
      .toThrow(expect.objectContaining({ code: "READ_ONLY" }));
  });

  it("validates patches", () => {
    expect(() => applyOp(WEEKLY, {
      kind: "update", target: { objectName: "obj.ics" }, now: NOW,
      patch: { end: { kind: "dateTime", dateTime: new Date("2026-03-01T00:00:00Z") } },
    }, CONTEXT)).toThrow(/end must not be before start/);
    expect(() => applyOp(WEEKLY, {
      kind: "update", target: { objectName: "obj.ics" }, now: NOW, patch: { start: { kind: "date", date: "2026-03-02" } },
    }, CONTEXT)).toThrow(/set both start and end/);
  });
});

describe("buildEventObject", () => {
  it("builds a timed repeating event with a VTIMEZONE that reads back identically", () => {
    const text = buildEventObject({
      title: "Swim", location: "Pool",
      start: { kind: "dateTime", dateTime: new Date("2026-09-22T16:00:00Z"), timeZone: "Europe/Amsterdam" },
      end: { kind: "dateTime", dateTime: new Date("2026-09-22T17:00:00Z"), timeZone: "Europe/Amsterdam" },
      alerts: [{ minutesBefore: 15 }],
      recurrence: { frequency: "weekly", byWeekday: ["TU", "TH"], count: 4 },
    }, "uid-1", CONTEXT, NOW);
    expect(text).toContain("BEGIN:VTIMEZONE");
    expect(text).toContain("DTSTART;TZID=Europe/Amsterdam:20260922T180000");
    expect(text).toContain("RRULE:FREQ=WEEKLY;BYDAY=TU,TH;COUNT=4");
    const events = eventsInWindow("uid-1.ics", text, CONTEXT, window("2026-09-01T00:00:00Z", "2026-11-01T00:00:00Z"), false);
    expect(events.map(event => event.start.kind === "dateTime" && event.start.dateTime.toISOString())).toEqual([
      "2026-09-22T16:00:00.000Z", "2026-09-24T16:00:00.000Z", "2026-09-29T16:00:00.000Z", "2026-10-01T16:00:00.000Z",
    ]);
    expect(events[0]).toMatchObject({ title: "Swim", location: "Pool", busy: true, alerts: [{ minutesBefore: 15 }], seriesId: "uid-1.ics" });
  });

  it("builds an all-day event in UTC-free DATE form", () => {
    const text = buildEventObject({
      title: "Holiday", start: { kind: "date", date: "2026-12-24" }, end: { kind: "date", date: "2026-12-27" }, busy: false,
    }, "uid-2", CONTEXT, NOW);
    expect(text).toContain("DTSTART;VALUE=DATE:20261224");
    expect(text).not.toContain("VTIMEZONE");
    expect(text).toContain("TRANSP:TRANSPARENT");
  });

  it("rejects invalid drafts", () => {
    const start = { kind: "dateTime" as const, dateTime: new Date("2026-09-22T16:00:00Z") };
    expect(() => buildEventObject({ title: " ", start, end: start }, "u", CONTEXT, NOW)).toThrow(/title/);
    expect(() => buildEventObject({ title: "x", start: { kind: "date", date: "2026-02-30" }, end: { kind: "date", date: "2026-03-01" } }, "u", CONTEXT, NOW))
      .toThrow(/valid YYYY-MM-DD/);
    expect(() => buildEventObject({ title: "x", start: { ...start, timeZone: "Mars/Olympus" }, end: start }, "u", CONTEXT, NOW))
      .toThrow(/IANA/);
    expect(() => buildEventObject({ title: "x", start, end: start, recurrence: { frequency: "daily", byWeekday: ["MO"] } }, "u", CONTEXT, NOW))
      .toThrow(/only allowed for weekly/);
  });
});
