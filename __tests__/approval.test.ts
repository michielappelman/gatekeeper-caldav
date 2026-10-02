import { describe, expect, it } from "vitest";
import {
  describeAlerts, describeCreate, describeDelete, describeOccurrence, describeRecurrence,
  describeUpdate,
} from "../src/approval";
import type { CalDavEventDraft } from "../src/types";

type Rendered = ReturnType<typeof describeCreate>;
const field = (rendered: Rendered, label: string) => rendered.fields?.find(f => f.label === label);

const DRAFT: CalDavEventDraft = {
  title: "Dinner at De Kaap",
  start: { kind: "dateTime", dateTime: new Date("2026-10-09T17:00:00Z"), timeZone: "Europe/Amsterdam" },
  end: { kind: "dateTime", dateTime: new Date("2026-10-09T19:30:00Z"), timeZone: "Europe/Amsterdam" },
  location: "Amersfoort",
  description: "Table for 4.\nAsk for the window seat.",
  alerts: [{ minutesBefore: 60 }],
};

describe("describeCreate", () => {
  it("shows every field and the iCalendar data, and is complete", () => {
    const ics = "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n";
    const rendered = describeCreate("Family", DRAFT, ics);
    expect(field(rendered, "Calendar")).toMatchObject({ kind: "inline", value: "Family" });
    expect(field(rendered, "Title")).toMatchObject({ value: "Dinner at De Kaap" });
    expect(field(rendered, "Starts")).toMatchObject({ value: "9 Oct 2026, 19:00 (Europe/Amsterdam)" });
    expect(field(rendered, "Ends")).toMatchObject({ value: "9 Oct 2026, 21:30 (Europe/Amsterdam)" });
    expect(field(rendered, "Location")).toMatchObject({ value: "Amersfoort" });
    expect(field(rendered, "Shows as")).toMatchObject({ value: "Busy" });
    expect(field(rendered, "Alerts")).toMatchObject({ items: ["1 hour(s) before"] });
    expect(field(rendered, "Notes")).toMatchObject({ kind: "text", value: DRAFT.description });
    expect(field(rendered, "iCalendar data (uploaded as-is)")).toMatchObject({ value: ics });
    expect(rendered.descriptionIsComplete).toBe(true);
  });

  it("describes a repeat rule", () => {
    const rendered = describeCreate("Family", {
      ...DRAFT, recurrence: { frequency: "weekly", interval: 2, byWeekday: ["MO", "WE"], count: 6 },
    }, "");
    expect(field(rendered, "Repeats")).toMatchObject({ value: "Every 2 weeks on Monday, Wednesday, 6 times" });
  });
});

describe("describeUpdate", () => {
  it("lists only the changed fields, and clears in words", () => {
    const rendered = describeUpdate("Family", "Dinner at De Kaap", undefined, {
      title: "Dinner at Tollius", location: null, alerts: [],
    });
    expect(rendered.fields?.map(f => f.label)).toEqual(["Calendar", "Event", "New title"]);
    expect(rendered.description).toContain("Removes the location.");
    expect(rendered.description).toContain("Removes all alerts.");
  });

  it("names the occurrence of a repeating event", () => {
    const rendered = describeUpdate("Work", "Standup", "20261003T070000Z", {
      start: { kind: "date", date: "2026-10-04" },
    });
    expect(rendered.description).toContain("only this occurrence");
    expect(field(rendered, "Occurrence")).toMatchObject({ value: "2026-10-03 07:00 UTC" });
    expect(field(rendered, "New start")).toMatchObject({ value: "2026-10-04" });
  });
});

describe("describeDelete", () => {
  it("names the event and calendar", () => {
    const rendered = describeDelete("Family", undefined, "20261003");
    expect(field(rendered, "Event")).toMatchObject({ value: "(untitled)" });
    expect(field(rendered, "Occurrence")).toMatchObject({ value: "2026-10-03" });
    expect(rendered.descriptionIsComplete).toBe(true);
  });
});

describe("helpers", () => {
  it("phrases alerts", () => {
    expect(describeAlerts([{ minutesBefore: 0 }, { minutesBefore: 15 }, { minutesBefore: 2880 }]))
      .toEqual(["At the start", "15 minutes before", "2 day(s) before"]);
  });

  it("phrases a daily rule with an end date", () => {
    expect(describeRecurrence({ frequency: "daily", until: new Date("2026-12-31T00:00:00Z") }))
      .toBe("Every day, until 2026-12-31");
  });

  it("formats occurrence keys", () => {
    expect(describeOccurrence("20261225")).toBe("2026-12-25");
  });
});
