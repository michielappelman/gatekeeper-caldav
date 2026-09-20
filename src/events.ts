/**
 * The event model: turns calendar objects (one iCalendar text per CalDAV resource) into the
 * agent-facing `CalDavEvent`s for a time window, and applies create/update/delete operations to an
 * object's text.
 *
 * `applyOp()` is deliberately pure — (current text, operation) -> new text — because it serves two
 * callers: simulation replays every pending operation onto the server's current text on each read,
 * and `applyAction()` runs the same operation against a freshly fetched copy once approved, so an
 * approved change lands on whatever the event looks like *then* rather than overwriting it with a
 * stale snapshot.
 *
 * Ids: a one-off event's id — and a repeating event's `seriesId` — is its CalDAV resource name
 * (the last path segment of its href). An occurrence's id is `<resource name>/<instance key>`,
 * where the instance key is its original start as `YYYYMMDD` (all-day) or `YYYYMMDDTHHMMSSZ` (UTC).
 */

import { CalDavError } from "./errors";
import {
  componentFromLines,
  escapeText,
  formatDate,
  formatDateTime,
  formatMinutesBefore,
  getProperties,
  getProperty,
  getText,
  instanceKey,
  parseDateTimeList,
  parseDateTimeProperty,
  parseDuration,
  parseICalendar,
  removeProperties,
  serializeICalendar,
  setProperty,
  toEpochMs,
  utcStamp,
  type ICalComponent,
  type ICalDateTime,
} from "./ical";
import { describeRRule, expandRecurrence, formatRRule, parseRRule, type RRule } from "./recurrence";
import { buildVTimezone, isValidTimeZone, utcToZoned } from "./timezone";
import type {
  CalDavAlert,
  CalDavAttendee,
  CalDavEvent,
  CalDavEventDraft,
  CalDavEventPatch,
  CalDavTime,
} from "./types";

/** What the event model needs to know about the calendar an object lives on. */
export type CalendarContext = {
  calendarId: string;
  /** IANA zone for all-day dates, floating times, and writes that name no zone. */
  defaultTz: string;
  /** The account's own addresses (lowercase, without `mailto:`), to mark `self` attendees. */
  selfAddresses: string[];
};

export type EventTarget = { objectName: string; occurrence?: string };

/** Longest window `listEvents()` accepts. */
export const MAX_WINDOW_MS = 366 * 86_400_000;

const OBJECT_NAME_RE = /^[^/?#\\\s]+$/;
const INSTANCE_KEY_RE = /^\d{8}(T\d{6}Z)?$/;

/** Validates a resource name taken from a caller-supplied id or a server href. */
export function isValidObjectName(name: string): boolean {
  return OBJECT_NAME_RE.test(name) && name !== "." && name !== ".." && !/%2f|%5c/i.test(name);
}

export function parseEventId(id: string): EventTarget {
  const slash = id.indexOf("/");
  const objectName = slash === -1 ? id : id.slice(0, slash);
  const occurrence = slash === -1 ? undefined : id.slice(slash + 1);
  if (!isValidObjectName(objectName) || (occurrence !== undefined && !INSTANCE_KEY_RE.test(occurrence))) {
    throw new CalDavError("INVALID_ARGUMENT", `Not a valid event id: "${id}".`);
  }
  return { objectName, occurrence };
}

export function formatEventId(target: EventTarget): string {
  return target.occurrence ? `${target.objectName}/${target.occurrence}` : target.objectName;
}

// ---------------------------------------------------------------------------
// Reading

type Window = { startMs: number; endMs: number };

function splitVEvents(calendar: ICalComponent): { master?: ICalComponent; overrides: ICalComponent[] } {
  const events = calendar.components.filter(component => component.name === "VEVENT");
  return {
    master: events.find(event => !getProperty(event, "RECURRENCE-ID")),
    overrides: events.filter(event => getProperty(event, "RECURRENCE-ID")),
  };
}

function eventStart(event: ICalComponent): ICalDateTime {
  const dtstart = getProperty(event, "DTSTART");
  if (!dtstart) throw new CalDavError("UPSTREAM_UNAVAILABLE", "An event on the server has no start time.");
  return parseDateTimeProperty(dtstart);
}

/** The event's end, from DTEND or DURATION, defaulting per RFC 5545 §3.6.1. */
function eventEnd(event: ICalComponent, start: ICalDateTime, defaultTz: string): ICalDateTime {
  const dtend = getProperty(event, "DTEND");
  if (dtend) return parseDateTimeProperty(dtend);
  const durationValue = getProperty(event, "DURATION")?.value;
  const durationMs = durationValue ? parseDuration(durationValue) : undefined;
  if (start.kind === "date") return addDays(start, durationMs ? Math.max(1, Math.round(durationMs / 86_400_000)) : 1);
  return shiftDateTime(start, durationMs ?? 0, defaultTz);
}

function addDays(date: Extract<ICalDateTime, { kind: "date" }>, days: number): ICalDateTime {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { kind: "date", year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

/** Moves a date-time by `ms` of elapsed time, keeping its zone. */
function shiftDateTime(value: Extract<ICalDateTime, { kind: "dateTime" }>, ms: number, defaultTz: string): ICalDateTime {
  const epoch = toEpochMs(value, defaultTz) + ms;
  const zone = value.zone.type === "tz" ? value.zone.tzid : value.zone.type === "utc" ? "UTC" : defaultTz;
  return { kind: "dateTime", local: utcToZoned(epoch, zone), zone: value.zone };
}

/** Elapsed duration (date-times) or day count in ms (dates) between start and end. */
function spanMs(start: ICalDateTime, end: ICalDateTime, defaultTz: string): number {
  if (start.kind === "date" && end.kind === "date") {
    return Date.UTC(end.year, end.month - 1, end.day) - Date.UTC(start.year, start.month - 1, start.day);
  }
  return toEpochMs(end, defaultTz) - toEpochMs(start, defaultTz);
}

function endFromSpan(start: ICalDateTime, span: number, defaultTz: string): ICalDateTime {
  if (start.kind === "date") return addDays(start, Math.max(1, Math.round(span / 86_400_000)));
  return shiftDateTime(start, span, defaultTz);
}

function toAgentTime(value: ICalDateTime, defaultTz: string): CalDavTime {
  if (value.kind === "date") {
    return { kind: "date", date: `${value.year}-${String(value.month).padStart(2, "0")}-${String(value.day).padStart(2, "0")}` };
  }
  const dateTime = new Date(toEpochMs(value, defaultTz));
  return value.zone.type === "tz" ? { kind: "dateTime", dateTime, timeZone: value.zone.tzid } : { kind: "dateTime", dateTime };
}

function stripMailto(value: string): string {
  return value.replace(/^mailto:/i, "").trim();
}

const PARTSTAT: Record<string, CalDavAttendee["status"]> = {
  "NEEDS-ACTION": "needsAction", ACCEPTED: "accepted", DECLINED: "declined", TENTATIVE: "tentative",
};

function readAlerts(event: ICalComponent): CalDavAlert[] | undefined {
  const alerts: CalDavAlert[] = [];
  for (const alarm of event.components.filter(component => component.name === "VALARM")) {
    const trigger = getProperty(alarm, "TRIGGER");
    if (!trigger || trigger.params.VALUE === "DATE-TIME" || trigger.params.RELATED === "END") continue;
    const ms = parseDuration(trigger.value);
    if (ms === undefined || ms > 0) continue;
    alerts.push({ minutesBefore: Math.round(-ms / 60_000) });
  }
  return alerts.length > 0 ? alerts : undefined;
}

function formatUntilForHumans(until: ICalDateTime): string {
  if (until.kind === "date") return `${until.year}-${String(until.month).padStart(2, "0")}-${String(until.day).padStart(2, "0")}`;
  return new Date(toEpochMs(until, "UTC")).toISOString().slice(0, 10);
}

function parseRule(event: ICalComponent): RRule | undefined {
  const rrule = getProperty(event, "RRULE");
  if (!rrule) return undefined;
  return parseRRule(rrule.value, raw => parseDateTimeProperty({ name: "UNTIL", params: {}, value: raw }));
}

function toAgentEvent(
  event: ICalComponent, start: ICalDateTime, end: ICalDateTime, id: string, context: CalendarContext,
  options: { includeDescriptions: boolean; seriesId?: string; repeats?: string },
): CalDavEvent {
  const status = getProperty(event, "STATUS")?.value.toUpperCase();
  const attendees = getProperties(event, "ATTENDEE").map((attendee): CalDavAttendee => {
    const email = stripMailto(attendee.value);
    return {
      email,
      name: attendee.params.CN || undefined,
      status: PARTSTAT[attendee.params.PARTSTAT?.toUpperCase() ?? "NEEDS-ACTION"],
      self: context.selfAddresses.includes(email.toLowerCase()) || undefined,
    };
  });
  const organizer = getProperty(event, "ORGANIZER");
  return {
    id,
    seriesId: options.seriesId,
    calendarId: context.calendarId,
    title: getText(event, "SUMMARY") ?? "(no title)",
    start: toAgentTime(start, context.defaultTz),
    end: toAgentTime(end, context.defaultTz),
    status: status === "CANCELLED" ? "cancelled" : status === "TENTATIVE" ? "tentative" : "confirmed",
    location: getText(event, "LOCATION"),
    description: options.includeDescriptions ? getText(event, "DESCRIPTION") : undefined,
    url: getProperty(event, "URL")?.value || undefined,
    busy: getProperty(event, "TRANSP")?.value.toUpperCase() !== "TRANSPARENT",
    organizer: organizer ? stripMailto(organizer.value) : undefined,
    attendees: attendees.length > 0 ? attendees : undefined,
    alerts: readAlerts(event),
    repeats: options.repeats,
  };
}

function overlaps(start: ICalDateTime, end: ICalDateTime, window: Window, defaultTz: string): boolean {
  const startMs = toEpochMs(start, defaultTz);
  const endMs = Math.max(toEpochMs(end, defaultTz), startMs);
  // A zero-length event at the window's start still counts as inside it.
  return startMs < window.endMs && (endMs > window.startMs || startMs === window.startMs);
}

type Instance = { key: string; start: ICalDateTime };

/** Instance starts of a recurring master (RRULE expansion plus RDATEs, minus EXDATEs). */
function masterInstances(master: ICalComponent, rule: RRule | undefined, window: Window, context: CalendarContext): Instance[] {
  const start = eventStart(master);
  const span = spanMs(start, eventEnd(master, start, context.defaultTz), context.defaultTz);
  const starts = rule
    ? expandRecurrence({
      start, rule, defaultTz: context.defaultTz,
      windowStartMs: window.startMs, windowEndMs: window.endMs, durationMs: span,
    })
    : [start];
  for (const rdate of getProperties(master, "RDATE")) starts.push(...parseDateTimeList(rdate));
  const excluded = new Set(getProperties(master, "EXDATE")
    .flatMap(parseDateTimeList).map(value => instanceKey(value, context.defaultTz)));
  const seen = new Set<string>();
  const out: Instance[] = [];
  for (const value of starts) {
    const key = instanceKey(value, context.defaultTz);
    if (excluded.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, start: value });
  }
  return out;
}

/** Every event (or occurrence) of one calendar object that overlaps the window, sorted by start. */
export function eventsInWindow(
  objectName: string, text: string, context: CalendarContext, window: Window, includeDescriptions: boolean,
): CalDavEvent[] {
  const calendar = parseICalendar(text);
  const { master, overrides } = splitVEvents(calendar);
  const events: CalDavEvent[] = [];
  const rule = master ? parseRule(master) : undefined;
  const recurring = master !== undefined && (rule !== undefined || getProperties(master, "RDATE").length > 0);
  const repeats = rule ? describeRRule(rule, formatUntilForHumans) : recurring ? "On specific dates" : undefined;

  if (master && !recurring) {
    const start = eventStart(master);
    const end = eventEnd(master, start, context.defaultTz);
    if (overlaps(start, end, window, context.defaultTz)) {
      events.push(toAgentEvent(master, start, end, objectName, context, { includeDescriptions }));
    }
  }

  const overrideKeys = new Set<string>();
  for (const override of overrides) {
    const recurrenceId = parseDateTimeProperty(getProperty(override, "RECURRENCE-ID")!);
    const key = instanceKey(recurrenceId, context.defaultTz);
    overrideKeys.add(key);
    const start = eventStart(override);
    const end = eventEnd(override, start, context.defaultTz);
    if (!overlaps(start, end, window, context.defaultTz)) continue;
    events.push(toAgentEvent(override, start, end, formatEventId({ objectName, occurrence: key }), context, {
      includeDescriptions, seriesId: objectName, repeats,
    }));
  }

  if (master && recurring) {
    const masterStart = eventStart(master);
    const span = spanMs(masterStart, eventEnd(master, masterStart, context.defaultTz), context.defaultTz);
    for (const instance of masterInstances(master, rule, window, context)) {
      if (overrideKeys.has(instance.key)) continue;
      const end = endFromSpan(instance.start, span, context.defaultTz);
      if (!overlaps(instance.start, end, window, context.defaultTz)) continue;
      events.push(toAgentEvent(master, instance.start, end, formatEventId({ objectName, occurrence: instance.key }), context, {
        includeDescriptions, seriesId: objectName, repeats,
      }));
    }
  }
  return sortEvents(events);
}

function sortKey(time: CalDavTime): number {
  return time.kind === "date" ? Date.parse(`${time.date}T00:00:00Z`) : time.dateTime.getTime();
}

/** Events ordered by start, then id. */
export function sortEvents(events: CalDavEvent[]): CalDavEvent[] {
  return events.toSorted((a, b) => sortKey(a.start) - sortKey(b.start) || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// Writing

export type EventOp =
  | { kind: "create"; objectName: string; ics: string }
  | { kind: "update"; target: EventTarget; patch: CalDavEventPatch; now: number }
  | { kind: "delete"; target: EventTarget; now: number };

function invalid(message: string): CalDavError {
  return new CalDavError("INVALID_ARGUMENT", message);
}

const DATE_INPUT_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Converts an agent-supplied time to an iCalendar value, validating it. */
function fromAgentTime(time: CalDavTime, context: CalendarContext, field: string): ICalDateTime {
  if (time.kind === "date") {
    const match = DATE_INPUT_RE.exec(time.date);
    const date = match ? new Date(Date.UTC(+match[1], +match[2] - 1, +match[3])) : undefined;
    if (!match || !date || date.getUTCDate() !== +match[3] || date.getUTCMonth() !== +match[2] - 1) {
      throw invalid(`${field}.date must be a valid YYYY-MM-DD date.`);
    }
    return { kind: "date", year: +match[1], month: +match[2], day: +match[3] };
  }
  if (time.kind !== "dateTime" || !(time.dateTime instanceof Date) || Number.isNaN(time.dateTime.getTime())) {
    throw invalid(`${field} must be { kind: "date", date } or { kind: "dateTime", dateTime: Date }.`);
  }
  const tz = time.timeZone ?? context.defaultTz;
  if (!isValidTimeZone(tz)) throw invalid(`${field}.timeZone "${tz}" is not a known IANA time zone.`);
  if (tz === "UTC" || tz === "Etc/UTC") {
    return { kind: "dateTime", local: utcToZoned(time.dateTime.getTime(), "UTC"), zone: { type: "utc" } };
  }
  return { kind: "dateTime", local: utcToZoned(time.dateTime.getTime(), tz), zone: { type: "tz", tzid: tz } };
}

function yearOf(value: ICalDateTime): number {
  return value.kind === "date" ? value.year : value.local.year;
}

/** Adds a VTIMEZONE for `value`'s zone to the calendar if it references one and none exists. */
function ensureVTimezone(calendar: ICalComponent, value: ICalDateTime): void {
  if (value.kind !== "dateTime" || value.zone.type !== "tz") return;
  const tzid = value.zone.tzid;
  const exists = calendar.components.some(component =>
    component.name === "VTIMEZONE" && getProperty(component, "TZID")?.value === tzid);
  if (exists) return;
  const firstEvent = calendar.components.findIndex(component => component.name !== "VTIMEZONE");
  const vtimezone = componentFromLines(buildVTimezone(tzid, yearOf(value)));
  calendar.components.splice(firstEvent === -1 ? calendar.components.length : firstEvent, 0, vtimezone);
}

function setDateTime(event: ICalComponent, name: string, value: ICalDateTime): void {
  const formatted = formatDateTime(value);
  setProperty(event, name, formatted.value, formatted.params);
}

function validateAlerts(alerts: CalDavAlert[]): void {
  for (const alert of alerts) {
    if (!Number.isInteger(alert.minutesBefore) || alert.minutesBefore < 0 || alert.minutesBefore > 40_320) {
      throw invalid("alerts[].minutesBefore must be a whole number of minutes between 0 and 40320.");
    }
  }
}

function setAlerts(event: ICalComponent, alerts: CalDavAlert[]): void {
  validateAlerts(alerts);
  event.components = event.components.filter(component => component.name !== "VALARM");
  for (const alert of alerts) {
    event.components.push({
      name: "VALARM",
      properties: [
        { name: "ACTION", params: {}, value: "DISPLAY" },
        { name: "DESCRIPTION", params: {}, value: "Reminder" },
        { name: "TRIGGER", params: {}, value: formatMinutesBefore(alert.minutesBefore) },
      ],
      components: [],
    });
  }
}

function setOptionalText(event: ICalComponent, name: string, value: string | null | undefined): void {
  if (value === undefined) return;
  setProperty(event, name, value === null || value === "" ? null : escapeText(value));
}

function setUrl(event: ICalComponent, value: string | null | undefined): void {
  if (value === undefined) return;
  if (value === null || value === "") {
    setProperty(event, "URL", null);
    return;
  }
  if (!URL.canParse(value)) throw invalid("url must be an absolute URL.");
  setProperty(event, "URL", value.replace(/[\r\n]/g, ""), { VALUE: "URI" });
}

function checkOrder(start: ICalDateTime, end: ICalDateTime, context: CalendarContext): void {
  if (start.kind !== end.kind) throw invalid("start and end must both be dates or both be date-times.");
  if (spanMs(start, end, context.defaultTz) <= 0 && start.kind === "date") {
    throw invalid("An all-day event's end date is exclusive and must be after its start date.");
  }
  if (spanMs(start, end, context.defaultTz) < 0) throw invalid("end must not be before start.");
}

function touch(event: ICalComponent, now: number): void {
  const sequence = Number.parseInt(getProperty(event, "SEQUENCE")?.value ?? "0", 10);
  setProperty(event, "SEQUENCE", String((Number.isFinite(sequence) ? sequence : 0) + 1));
  setProperty(event, "DTSTAMP", utcStamp(now));
  setProperty(event, "LAST-MODIFIED", utcStamp(now));
}

function applyPatch(calendar: ICalComponent, event: ICalComponent, patch: CalDavEventPatch, context: CalendarContext, isSeries: boolean): void {
  if (patch.title !== undefined) {
    if (!patch.title.trim()) throw invalid("title must not be empty.");
    setProperty(event, "SUMMARY", escapeText(patch.title));
  }
  setOptionalText(event, "LOCATION", patch.location);
  setOptionalText(event, "DESCRIPTION", patch.description);
  setUrl(event, patch.url);
  if (patch.busy !== undefined) setProperty(event, "TRANSP", patch.busy ? "OPAQUE" : "TRANSPARENT");
  if (patch.alerts !== undefined) setAlerts(event, patch.alerts);

  if (patch.start !== undefined || patch.end !== undefined) {
    const oldStart = eventStart(event);
    const oldEnd = eventEnd(event, oldStart, context.defaultTz);
    const start = patch.start ? fromAgentTime(patch.start, context, "start") : oldStart;
    let end: ICalDateTime;
    if (patch.end) end = fromAgentTime(patch.end, context, "end");
    else if (start.kind === oldStart.kind) end = endFromSpan(start, spanMs(oldStart, oldEnd, context.defaultTz), context.defaultTz);
    else throw invalid("When switching between an all-day and a timed event, set both start and end.");
    checkOrder(start, end, context);
    if (isSeries && start.kind !== oldStart.kind && getProperty(event, "RRULE")) {
      throw invalid("A repeating event cannot be switched between all-day and timed.");
    }
    setDateTime(event, "DTSTART", start);
    removeProperties(event, "DURATION");
    setDateTime(event, "DTEND", end);
    ensureVTimezone(calendar, start);
    ensureVTimezone(calendar, end);
  }
}

function assertNoAttendees(events: ICalComponent[]): void {
  if (events.some(event => getProperties(event, "ATTENDEE").length > 0)) {
    throw new CalDavError("READ_ONLY", "Events with attendees (invitations) cannot be changed or deleted here.");
  }
}

/** Finds a series instance by key, so an occurrence edit/delete can name its exact original start. */
function findInstance(master: ICalComponent, key: string, context: CalendarContext): ICalDateTime {
  const rule = parseRule(master);
  if (!rule && getProperties(master, "RDATE").length === 0) {
    throw new CalDavError("RESOURCE_NOT_FOUND", "That event does not repeat; use its id without an occurrence.");
  }
  const at = key.length === 8
    ? Date.UTC(+key.slice(0, 4), +key.slice(4, 6) - 1, +key.slice(6, 8))
    : Date.UTC(+key.slice(0, 4), +key.slice(4, 6) - 1, +key.slice(6, 8), +key.slice(9, 11), +key.slice(11, 13), +key.slice(13, 15));
  const dayMs = 86_400_000;
  const match = masterInstances(master, rule, { startMs: at - dayMs, endMs: at + dayMs }, context)
    .find(instance => instance.key === key);
  if (!match) throw new CalDavError("RESOURCE_NOT_FOUND", "That occurrence does not exist.");
  return match.start;
}

/** Clones a master into an override for one occurrence, without its recurrence properties. */
function makeOverride(master: ICalComponent, instanceStart: ICalDateTime, context: CalendarContext): ICalComponent {
  const masterStart = eventStart(master);
  const span = spanMs(masterStart, eventEnd(master, masterStart, context.defaultTz), context.defaultTz);
  const override: ICalComponent = structuredClone(master);
  for (const name of ["RRULE", "RDATE", "EXDATE", "EXRULE", "DURATION"]) removeProperties(override, name);
  setDateTime(override, "RECURRENCE-ID", instanceStart);
  setDateTime(override, "DTSTART", instanceStart);
  setDateTime(override, "DTEND", endFromSpan(instanceStart, span, context.defaultTz));
  return override;
}

/**
 * Applies one operation to an object's current text (`null` when it does not exist) and returns the
 * new text, or `null` when the object should be deleted. Throws a `CalDavError` if the operation no
 * longer applies (target missing, invitation, …).
 */
export function applyOp(text: string | null, op: EventOp, context: CalendarContext): string | null {
  if (op.kind === "create") {
    if (text !== null) throw new CalDavError("CONFLICT", "An event with this id already exists.");
    return op.ics;
  }
  if (text === null) throw new CalDavError("RESOURCE_NOT_FOUND", "That event does not exist.");
  const calendar = parseICalendar(text);
  const { master, overrides } = splitVEvents(calendar);
  const occurrence = op.target.occurrence;
  const overrideFor = (key: string) => overrides.find(override =>
    instanceKey(parseDateTimeProperty(getProperty(override, "RECURRENCE-ID")!), context.defaultTz) === key);

  if (op.kind === "delete") {
    if (!occurrence) {
      assertNoAttendees([...(master ? [master] : []), ...overrides]);
      return null;
    }
    const override = overrideFor(occurrence);
    assertNoAttendees([...(master ? [master] : []), ...(override ? [override] : [])]);
    if (!master) {
      if (!override) throw new CalDavError("RESOURCE_NOT_FOUND", "That occurrence does not exist.");
    } else {
      const instance = override
        ? parseDateTimeProperty(getProperty(override, "RECURRENCE-ID")!)
        : findInstance(master, occurrence, context);
      const formatted = formatDateTime(instance);
      master.properties.push({ name: "EXDATE", params: formatted.params, value: formatted.value });
      touch(master, op.now);
    }
    if (override) calendar.components = calendar.components.filter(component => component !== override);
    return calendar.components.some(component => component.name === "VEVENT") ? serializeICalendar(calendar) : null;
  }

  // update
  if (!occurrence) {
    if (!master) throw new CalDavError("RESOURCE_NOT_FOUND", "That event only exists as individual occurrences.");
    assertNoAttendees([master, ...overrides]);
    applyPatch(calendar, master, op.patch, context, true);
    touch(master, op.now);
    return serializeICalendar(calendar);
  }
  let override = overrideFor(occurrence);
  assertNoAttendees([...(master ? [master] : []), ...(override ? [override] : [])]);
  if (!override) {
    if (!master) throw new CalDavError("RESOURCE_NOT_FOUND", "That occurrence does not exist.");
    override = makeOverride(master, findInstance(master, occurrence, context), context);
    calendar.components.push(override);
  }
  applyPatch(calendar, override, op.patch, context, false);
  touch(override, op.now);
  return serializeICalendar(calendar);
}

/** Builds a new calendar object for a draft. Validates the draft; throws INVALID_ARGUMENT. */
export function buildEventObject(draft: CalDavEventDraft, uid: string, context: CalendarContext, now: number): string {
  if (typeof draft.title !== "string" || !draft.title.trim()) throw invalid("title must not be empty.");
  const start = fromAgentTime(draft.start, context, "start");
  const end = fromAgentTime(draft.end, context, "end");
  checkOrder(start, end, context);

  const event: ICalComponent = { name: "VEVENT", properties: [], components: [] };
  const stamp = utcStamp(now);
  setProperty(event, "UID", uid);
  setProperty(event, "DTSTAMP", stamp);
  setProperty(event, "CREATED", stamp);
  setProperty(event, "LAST-MODIFIED", stamp);
  setProperty(event, "SEQUENCE", "0");
  setProperty(event, "SUMMARY", escapeText(draft.title));
  setDateTime(event, "DTSTART", start);
  setDateTime(event, "DTEND", end);
  setOptionalText(event, "LOCATION", draft.location);
  setOptionalText(event, "DESCRIPTION", draft.description);
  setUrl(event, draft.url);
  setProperty(event, "TRANSP", draft.busy === false ? "TRANSPARENT" : "OPAQUE");
  if (draft.recurrence) setProperty(event, "RRULE", buildRRule(draft.recurrence, start, context));
  if (draft.alerts) setAlerts(event, draft.alerts);

  const calendar: ICalComponent = {
    name: "VCALENDAR",
    properties: [
      { name: "VERSION", params: {}, value: "2.0" },
      { name: "PRODID", params: {}, value: "-//Cloudflare OS//CalDAV Gatekeeper//EN" },
      { name: "CALSCALE", params: {}, value: "GREGORIAN" },
    ],
    components: [event],
  };
  ensureVTimezone(calendar, start);
  ensureVTimezone(calendar, end);
  return serializeICalendar(calendar);
}

function buildRRule(recurrence: NonNullable<CalDavEventDraft["recurrence"]>, start: ICalDateTime, context: CalendarContext): string {
  const freq = recurrence.frequency?.toUpperCase();
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY" && freq !== "YEARLY") {
    throw invalid("recurrence.frequency must be daily, weekly, monthly, or yearly.");
  }
  if (recurrence.interval !== undefined && (!Number.isInteger(recurrence.interval) || recurrence.interval < 1)) {
    throw invalid("recurrence.interval must be a positive whole number.");
  }
  if (recurrence.until !== undefined && recurrence.count !== undefined) {
    throw invalid("recurrence.until and recurrence.count cannot both be set.");
  }
  if (recurrence.count !== undefined && (!Number.isInteger(recurrence.count) || recurrence.count < 1)) {
    throw invalid("recurrence.count must be a positive whole number.");
  }
  if (recurrence.byWeekday && freq !== "WEEKLY") throw invalid("recurrence.byWeekday is only allowed for weekly events.");
  if (recurrence.byWeekday?.some(day => !["MO", "TU", "WE", "TH", "FR", "SA", "SU"].includes(day))) {
    throw invalid("recurrence.byWeekday entries must be MO, TU, WE, TH, FR, SA, or SU.");
  }
  let until: string | undefined;
  if (recurrence.until !== undefined) {
    if (!(recurrence.until instanceof Date) || Number.isNaN(recurrence.until.getTime())) {
      throw invalid("recurrence.until must be a Date.");
    }
    if (start.kind === "date") {
      // The last date on which an occurrence may start, as a DATE in the calendar's zone.
      const local = utcToZoned(recurrence.until.getTime(), context.defaultTz);
      until = formatDate(local.year, local.month, local.day);
    } else {
      until = utcStamp(recurrence.until.getTime());
    }
  }
  return formatRRule({
    freq, interval: recurrence.interval, byDay: recurrence.byWeekday, until, count: recurrence.count,
  });
}

/** A one-line human summary of a draft or patch time, for approval descriptions. */
export function describeTime(time: CalDavTime | undefined): string {
  if (!time) return "";
  if (time.kind === "date") return time.date;
  const zone = time.timeZone ?? "UTC";
  try {
    return `${time.dateTime.toLocaleString("en-GB", { timeZone: zone, dateStyle: "medium", timeStyle: "short" })} (${zone})`;
  } catch {
    return time.dateTime.toISOString();
  }
}

/** The event's title from an object's text, for approval descriptions; best-effort. */
export function titleOf(text: string | null, target: EventTarget, context: CalendarContext): string | undefined {
  if (!text) return undefined;
  try {
    const calendar = parseICalendar(text);
    const { master, overrides } = splitVEvents(calendar);
    const override = target.occurrence
      ? overrides.find(event => instanceKey(parseDateTimeProperty(getProperty(event, "RECURRENCE-ID")!), context.defaultTz) === target.occurrence)
      : undefined;
    const event = override ?? master ?? overrides[0];
    return event ? getText(event, "SUMMARY") : undefined;
  } catch {
    return undefined;
  }
}

