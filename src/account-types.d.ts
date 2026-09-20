import type {
  CalDavCalendarInfo,
  CalDavEvent,
  CalDavListEventsOptions,
  CalDavSession,
  CalDavTimeContext,
} from "./types";

/** A busy interval. No event details are included. */
export type CalDavBusyBlock = { start: Date; end: Date };

/**
 * Access to every calendar of one connected CalDAV account (such as iCloud). The account was
 * chosen when this connection was created and cannot be changed from here.
 */
export interface CalDavAccountSession {
  /**
   * Returns the current date and time in the time zone most of this account's calendars use. Call
   * this before working out a window from a relative phrase such as "next week".
   */
  getCurrentTime(): Promise<CalDavTimeContext>;

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
