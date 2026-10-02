// What the approver reads before a calendar write leaves the workspace: every field of a new
// event, every changed field of an edit, and which event a delete removes. Values go in `fields`,
// which approval surfaces show literally (see @gadgets/gatekeeper-kit/action-description).

import {
  buildDescription, type ActionDescriptionBuilder, type RenderedDescription,
} from "@gadgets/gatekeeper-kit/action-description";
import { describeTime } from "./events";
import type { CalDavAlert, CalDavEventDraft, CalDavEventPatch, CalDavRecurrence } from "./types";

const WEEKDAYS: Record<string, string> = {
  MO: "Monday", TU: "Tuesday", WE: "Wednesday", TH: "Thursday", FR: "Friday", SA: "Saturday",
  SU: "Sunday",
};
const PERIOD: Record<CalDavRecurrence["frequency"], string> = {
  daily: "day", weekly: "week", monthly: "month", yearly: "year",
};

/** A repeat rule in words, e.g. "Every 2 weeks on Monday, Wednesday, until 2026-12-31". */
export function describeRecurrence(rule: CalDavRecurrence): string {
  const interval = rule.interval ?? 1;
  let text = interval === 1 ? `Every ${PERIOD[rule.frequency]}` : `Every ${interval} ${PERIOD[rule.frequency]}s`;
  if (rule.byWeekday?.length) text += ` on ${rule.byWeekday.map(day => WEEKDAYS[day] ?? day).join(", ")}`;
  if (rule.until) text += `, until ${rule.until.toISOString().slice(0, 10)}`;
  if (rule.count) text += `, ${rule.count} times`;
  return text;
}

/** An alert list in words, e.g. ["15 minutes before", "At the start"]. */
export function describeAlerts(alerts: CalDavAlert[]): string[] {
  return alerts.map(({ minutesBefore: m }) =>
    m === 0 ? "At the start"
      : m % 1440 === 0 ? `${m / 1440} day(s) before`
      : m % 60 === 0 ? `${m / 60} hour(s) before`
      : `${m} minutes before`);
}

/** An occurrence key ("20261003" or "20261003T090000Z") as a date, or date and UTC time. */
export function describeOccurrence(key: string): string {
  const date = `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}`;
  return key.length > 8 ? `${date} ${key.slice(9, 11)}:${key.slice(11, 13)} UTC` : date;
}

function eventFields(builder: ActionDescriptionBuilder, event: CalDavEventDraft): void {
  builder.inline("Title", event.title);
  builder.inline("Starts", describeTime(event.start));
  builder.inline("Ends", describeTime(event.end));
  if (event.recurrence) builder.inline("Repeats", describeRecurrence(event.recurrence));
  if (event.location) builder.inline("Location", event.location);
  if (event.url) builder.inline("URL", event.url);
  builder.inline("Shows as", event.busy === false ? "Free" : "Busy");
  if (event.alerts?.length) builder.list("Alerts", describeAlerts(event.alerts));
  if (event.description) builder.verbatim("Notes", event.description);
}

/**
 * A new event: its fields in words, then the iCalendar object exactly as it is uploaded, which
 * makes the description complete.
 */
export function describeCreate(calendarName: string, event: CalDavEventDraft, ics: string): RenderedDescription {
  const builder = buildDescription("Add a new event to this calendar.").inline("Calendar", calendarName);
  eventFields(builder, event);
  builder.verbatim("iCalendar data (uploaded as-is)", ics);
  return builder.finish();
}

/**
 * An edit: which event, and the new value of each field that changes. Everything else in the
 * event, which comes from the server, is written back unchanged.
 */
export function describeUpdate(
    calendarName: string, eventTitle: string | undefined, occurrence: string | undefined,
    patch: CalDavEventPatch): RenderedDescription {
  const builder = buildDescription(
    `Change this event${occurrence ? " (only this occurrence)" : ""}. Fields not listed stay as they are.`)
    .inline("Calendar", calendarName)
    .inline("Event", eventTitle ?? "(untitled)");
  if (occurrence) builder.inline("Occurrence", describeOccurrence(occurrence));
  if (patch.title !== undefined) builder.inline("New title", patch.title);
  if (patch.start !== undefined) builder.inline("New start", describeTime(patch.start));
  if (patch.end !== undefined) builder.inline("New end", describeTime(patch.end));
  for (const [key, label] of [["location", "location"], ["url", "URL"]] as const) {
    const value = patch[key];
    if (value === null) builder.prose(`Removes the ${label}.`);
    else if (value !== undefined) builder.inline(`New ${label}`, value);
  }
  if (patch.busy !== undefined) builder.inline("Shows as", patch.busy ? "Busy" : "Free");
  if (patch.alerts !== undefined) {
    if (patch.alerts.length) builder.list("Alerts (replace all)", describeAlerts(patch.alerts));
    else builder.prose("Removes all alerts.");
  }
  if (patch.description === null) builder.prose("Removes the notes.");
  else if (patch.description !== undefined) builder.verbatim("New notes", patch.description);
  return builder.finish();
}

/** A delete: which event, or which occurrence of a repeating one. */
export function describeDelete(
    calendarName: string, eventTitle: string | undefined, occurrence: string | undefined): RenderedDescription {
  const builder = buildDescription(occurrence
    ? "Delete one occurrence of this repeating event; the others stay."
    : "Delete this event from the calendar.")
    .inline("Calendar", calendarName)
    .inline("Event", eventTitle ?? "(untitled)");
  if (occurrence) builder.inline("Occurrence", describeOccurrence(occurrence));
  return builder.finish();
}
