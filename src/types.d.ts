/** Metadata about one calendar. */
export type CalDavCalendarInfo = {
  /** Stable calendar id. Pass this to `CalDavAccountSession.getCalendar()`. */
  id: string;
  /** Display name, as shown in the Calendar app. */
  name: string;
  /** Display color as `#RRGGBB`, if set. */
  color?: string;
  description?: string;
  /** Calendar's default IANA time zone, e.g. `Europe/Amsterdam`, if set. */
  timeZone?: string;
  /** True when events on this calendar cannot be changed (e.g. a subscribed or read-only shared
   * calendar). Creating, updating, or deleting events on it throws. */
  readOnly: boolean;
};

/**
 * A calendar date or date/time.
 *
 * All-day events use `{ kind: "date", date: "YYYY-MM-DD" }`. The end date is exclusive, so a
 * one-day all-day event on 2026-06-09 ends on 2026-06-10.
 *
 * Timed events use `{ kind: "dateTime", dateTime: Date, timeZone?: string }`. `timeZone` is an
 * IANA name; when omitted on write, the calendar's own time zone is used (or UTC if it has none).
 */
export type CalDavTime =
  | { kind: "date"; date: string }
  | { kind: "dateTime"; dateTime: Date; timeZone?: string };

/** An attendee on an event. Attendees are read-only here. */
export type CalDavAttendee = {
  email: string;
  name?: string;
  status?: "needsAction" | "accepted" | "declined" | "tentative";
  /** True if this attendee is the connected account itself. */
  self?: boolean;
};

/** An alert shown before an event starts. */
export type CalDavAlert = {
  /** Minutes before the event start; 0 means at the start time. */
  minutesBefore: number;
};

/**
 * One event — or, for a repeating event, one occurrence of it.
 *
 * Repeating events are returned as their individual occurrences within the requested window,
 * never as a single rule. Every occurrence has its own `id`, and shares a `seriesId` with the
 * other occurrences of the same repeating event.
 */
export type CalDavEvent = {
  /**
   * Identifies exactly this item. For a one-off event, this is the event. For an occurrence of a
   * repeating event, this is only that occurrence. Pass to `updateEvent()` / `deleteEvent()`.
   */
  id: string;
  /**
   * Set only on occurrences of a repeating event. Pass this instead of `id` to `updateEvent()` /
   * `deleteEvent()` to affect every occurrence of the series.
   */
  seriesId?: string;
  /** The calendar this event is on. */
  calendarId: string;
  title: string;
  start: CalDavTime;
  end: CalDavTime;
  status: "confirmed" | "tentative" | "cancelled";
  location?: string;
  /** Notes/body. Only included when `includeDescriptions` is requested. */
  description?: string;
  /** URL attached to the event, if any. */
  url?: string;
  /** False when the event is shown as "free" rather than blocking time. */
  busy: boolean;
  /** Organizer's email address, for invitations. */
  organizer?: string;
  attendees?: CalDavAttendee[];
  alerts?: CalDavAlert[];
  /**
   * Human-readable description of how the series repeats (e.g. "Weekly on Monday, Wednesday"),
   * present only on occurrences of a repeating event.
   */
  repeats?: string;
};

/** How a new event repeats. `until` and `count` are mutually exclusive; omit both to repeat forever. */
export type CalDavRecurrence = {
  frequency: "daily" | "weekly" | "monthly" | "yearly";
  /** Repeat every N periods. Defaults to 1. */
  interval?: number;
  /** For `weekly`: which weekdays. Defaults to the start date's weekday. */
  byWeekday?: ("MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU")[];
  /** Last date (inclusive) on which an occurrence may start. */
  until?: Date;
  /** Total number of occurrences. */
  count?: number;
};

/** Fields for a new event. Events with attendees cannot be created here. */
export type CalDavEventDraft = {
  title: string;
  start: CalDavTime;
  end: CalDavTime;
  location?: string;
  description?: string;
  url?: string;
  /** Defaults to true. */
  busy?: boolean;
  alerts?: CalDavAlert[];
  recurrence?: CalDavRecurrence;
};

/**
 * Fields to change on an existing event. Only fields you set change. Set a string field to `null`
 * to clear it. `alerts` replaces the whole list.
 */
export type CalDavEventPatch = {
  title?: string;
  start?: CalDavTime;
  end?: CalDavTime;
  location?: string | null;
  description?: string | null;
  url?: string | null;
  busy?: boolean;
  alerts?: CalDavAlert[];
};

export type CalDavListEventsOptions = {
  /** Start of the window (inclusive). */
  start: Date;
  /** End of the window (exclusive). At most 366 days after `start`. */
  end: Date;
  /** Include event notes in `description`. Defaults to false. */
  includeDescriptions?: boolean;
};

/** A busy interval. No event details are included. */
export type CalDavBusyBlock = { start: Date; end: Date };

/**
 * Read-write access to one calendar on a CalDAV server (such as iCloud). The calendar was chosen
 * when this connection was created and cannot be changed from here.
 */
export interface CalDavSession {
  /** Returns metadata about this calendar. */
  getCalendar(): Promise<CalDavCalendarInfo>;

  /**
   * Lists every event overlapping the window, sorted by start. Repeating events are expanded into
   * their occurrences. The whole window is returned at once; a very dense window throws rather
   * than truncating — narrow it and retry.
   *
   * @example
   * ```ts
   * const now = new Date();
   * const week = await calendar.listEvents({
   *   start: now,
   *   end: new Date(now.getTime() + 7 * 86_400_000),
   * });
   * ```
   */
  listEvents(opts: CalDavListEventsOptions): Promise<CalDavEvent[]>;

  /**
   * Creates an event and returns its `id` (for a repeating event, its `seriesId`). The event
   * shows up in `listEvents()` immediately and can be passed to `updateEvent()` / `deleteEvent()`
   * straight away.
   */
  createEvent(event: CalDavEventDraft): Promise<{ id: string }>;

  /**
   * Changes an event. Pass an occurrence's `id` to change only that occurrence, or its `seriesId`
   * to change every occurrence. When changing a whole series, `start`/`end` move the series' first
   * occurrence and every later occurrence moves with it.
   *
   * Events that have attendees (invitations you organize or received) cannot be changed here and
   * throw.
   */
  updateEvent(id: string, patch: CalDavEventPatch): Promise<void>;

  /**
   * Deletes an event. Pass an occurrence's `id` to remove only that occurrence, or its `seriesId`
   * to delete the whole series. Events with attendees cannot be deleted here and throw.
   */
  deleteEvent(id: string): Promise<void>;
}

/**
 * Access to every calendar of one connected CalDAV account (such as iCloud). The account was
 * chosen when this connection was created and cannot be changed from here.
 */
export interface CalDavAccountSession {
  /** Lists the account's event calendars (task and reminder lists are not included). */
  listCalendars(): Promise<CalDavCalendarInfo[]>;

  /** Opens one calendar by `CalDavCalendarInfo.id`. */
  getCalendar(calendarId: string): Promise<CalDavSession>;

  /**
   * Lists events across all of the account's calendars, sorted by start. Same semantics as
   * `CalDavSession.listEvents()`; use each event's `calendarId` to tell them apart.
   */
  listEvents(opts: CalDavListEventsOptions): Promise<CalDavEvent[]>;

  /**
   * Returns merged busy time across all of the account's calendars in the window, ignoring events
   * marked free or cancelled. Overlapping and adjacent blocks are merged. Useful for finding a slot
   * without reading event details.
   */
  getBusyTime(opts: { start: Date; end: Date }): Promise<CalDavBusyBlock[]>;
}
