/**
 * Reads, simulation, and the pending-action journal for one gatekeeper instance (one binding).
 *
 * Simulation is "overlay at read time" (write-gatekeeper skill, Phase 2): each submitted
 * create/update/delete is journaled as an `EventOp` under its action id, and every read replays the
 * calendar's pending ops, in action-id order, onto the server's current text of each affected
 * object before expanding events. Approval replays the same op onto a freshly fetched copy
 * (`applyOp` is shared), so nothing is written from a stale snapshot. Rejection just drops the
 * journal entry — there is no cached state to repair.
 */

import {
  deleteObject,
  getObject,
  listCalendars,
  objectUrl,
  putObject,
  queryObjects,
  type CalendarRecord,
  type Credentials,
  type FetchLike,
} from "./caldav-api";
import { CalDavError } from "./errors";
import { applyOp, eventsInWindow, sortEvents, type CalendarContext, type EventOp } from "./events";
import type { CalDavEvent } from "./types";

/** The subset of `DurableObjectStorage["kv"]` this module needs, for easy unit testing. */
export type CacheKv = {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  delete(key: string): boolean | void;
};

/** What the gatekeeper stores for a connected account. Never leaves the UserAccount/gatekeeper DOs. */
export type Grant = Credentials & {
  serverUrl: string;
  homeUrl: string;
  addresses: string[];
  displayName?: string;
};

/** The UserAccount surface the store uses (a DO stub in production, a fake in tests). */
export type AccountAccess = {
  getGrant(): Promise<Grant>;
  noteCredentialsExpired(): Promise<void>;
};

export type PendingRecord = {
  calendarId: string;
  objectName: string;
  op: EventOp;
};

/** How long a fetched calendar list is trusted before re-fetching. */
export const CALENDAR_CACHE_TTL_MS = 60_000;
/** Most events one read may return before it throws instead of truncating. */
export const MAX_EVENTS = 2_500;

const CALENDARS_KEY = "cache:calendars";
const PENDING_IDS_KEY = "action:pendingIds";
const NEXT_ID_KEY = "action:nextId";

function pendingKey(actionId: number): string {
  return `action:pending:${actionId}`;
}

export function nextActionId(kv: CacheKv): number {
  const actionId = kv.get<number>(NEXT_ID_KEY) ?? 1;
  kv.put(NEXT_ID_KEY, actionId + 1);
  return actionId;
}

export function putPending(kv: CacheKv, actionId: number, record: PendingRecord): void {
  kv.put(pendingKey(actionId), record);
  const ids = kv.get<number[]>(PENDING_IDS_KEY) ?? [];
  if (!ids.includes(actionId)) kv.put(PENDING_IDS_KEY, [...ids, actionId]);
}

export function getPending(kv: CacheKv, actionId: number): PendingRecord | undefined {
  return kv.get<PendingRecord>(pendingKey(actionId));
}

export function deletePending(kv: CacheKv, actionId: number): void {
  kv.delete(pendingKey(actionId));
  kv.put(PENDING_IDS_KEY, (kv.get<number[]>(PENDING_IDS_KEY) ?? []).filter(id => id !== actionId));
}

/** Pending records for one calendar, in action-id (submission) order. */
export function listPending(kv: CacheKv, calendarId: string): { actionId: number; record: PendingRecord }[] {
  return (kv.get<number[]>(PENDING_IDS_KEY) ?? [])
    .toSorted((a, b) => a - b)
    .flatMap(actionId => {
      const record = getPending(kv, actionId);
      return record && record.calendarId === calendarId ? [{ actionId, record }] : [];
    });
}

type Window = { startMs: number; endMs: number };

export class CalendarStore {
  readonly #account: AccountAccess;
  readonly #kv: CacheKv;
  readonly #fetch: FetchLike;
  readonly #onError: (event: string, error: unknown) => void;

  constructor(
    account: AccountAccess, kv: CacheKv, onError: (event: string, error: unknown) => void,
    fetchImpl: FetchLike = (input, init) => fetch(input, init),
  ) {
    this.#account = account;
    this.#kv = kv;
    this.#onError = onError;
    this.#fetch = fetchImpl;
  }

  /** Runs a CalDAV call, turning rejected credentials into a reconnect prompt. */
  async #call<T>(fn: (grant: Grant) => Promise<T>): Promise<T> {
    const grant = await this.#account.getGrant();
    try {
      return await fn(grant);
    } catch (error) {
      if (error instanceof CalDavError && error.code === "AUTH_EXPIRED") {
        await this.#account.noteCredentialsExpired();
        throw new CalDavError(
          "AUTH_EXPIRED",
          "The calendar server rejected the stored password (it may have been revoked). Please " +
          "reconnect the account.",
          { cause: error });
      }
      throw error;
    }
  }

  async calendars(options: { refresh?: boolean } = {}): Promise<CalendarRecord[]> {
    const now = Date.now();
    const cached = this.#kv.get<{ calendars: CalendarRecord[]; fetchedAt: number }>(CALENDARS_KEY);
    if (!options.refresh && cached && now - cached.fetchedAt < CALENDAR_CACHE_TTL_MS) return cached.calendars;
    const calendars = await this.#call(grant => listCalendars(grant.homeUrl, grant, this.#fetch));
    this.#kv.put(CALENDARS_KEY, { calendars, fetchedAt: now });
    return calendars;
  }

  async calendar(calendarId: string): Promise<CalendarRecord> {
    const found = (await this.calendars()).find(calendar => calendar.id === calendarId)
      // A calendar created moments ago may not be in the cached list yet.
      ?? (await this.calendars({ refresh: true })).find(calendar => calendar.id === calendarId);
    if (!found) throw new CalDavError("RESOURCE_NOT_FOUND", `No calendar with id "${calendarId}" on this account.`);
    return found;
  }

  async context(calendar: CalendarRecord): Promise<CalendarContext> {
    const grant = await this.#account.getGrant();
    return { calendarId: calendar.id, defaultTz: calendar.timeZone ?? "UTC", selfAddresses: grant.addresses };
  }

  /** Events overlapping the window, with this binding's pending changes applied. */
  async listEvents(calendar: CalendarRecord, window: Window, includeDescriptions: boolean): Promise<CalDavEvent[]> {
    const context = await this.context(calendar);
    const objects = new Map<string, string>();
    for (const object of await this.#call(grant =>
      queryObjects(calendar.url, window.startMs, window.endMs, grant, this.#fetch))) {
      objects.set(object.name, object.data);
    }

    const pending = listPending(this.#kv, calendar.id);
    // An update can move an event into the window from outside it, so fetch those objects too.
    const missing = [...new Set(pending
      .filter(({ record }) => record.op.kind === "update" && !objects.has(record.objectName))
      .map(({ record }) => record.objectName))];
    await Promise.all(missing.map(async name => {
      const object = await this.#call(grant => getObject(objectUrl(calendar.url, name), grant, this.#fetch));
      if (object) objects.set(name, object.data);
    }));
    this.#replay(objects, pending, context);

    const events: CalDavEvent[] = [];
    for (const [name, text] of objects) {
      try {
        events.push(...eventsInWindow(name, text, context, window, includeDescriptions));
      } catch (error) {
        // One unreadable object must not hide the rest of the calendar.
        this.#onError("events.parseFailed", error);
      }
      if (events.length > MAX_EVENTS) {
        throw new CalDavError("TOO_MANY_EVENTS", "Too many events in this window; narrow it and retry.");
      }
    }
    return sortEvents(events);
  }

  #replay(objects: Map<string, string>, pending: { actionId: number; record: PendingRecord }[], context: CalendarContext): void {
    for (const { record } of pending) {
      try {
        const next = applyOp(objects.get(record.objectName) ?? null, record.op, context);
        if (next === null) objects.delete(record.objectName);
        else objects.set(record.objectName, next);
      } catch {
        // The change no longer applies to the server's current state (e.g. the event was deleted
        // elsewhere); it will fail again at approval, so it is simply not shown.
      }
    }
  }

  /** An object's current text with pending changes applied, or null if it does not exist. */
  async currentText(calendar: CalendarRecord, objectName: string): Promise<string | null> {
    const pending = listPending(this.#kv, calendar.id).filter(({ record }) => record.objectName === objectName);
    const objects = new Map<string, string>();
    if (pending[0]?.record.op.kind !== "create") {
      const object = await this.#call(grant => getObject(objectUrl(calendar.url, objectName), grant, this.#fetch));
      if (object) objects.set(objectName, object.data);
    }
    this.#replay(objects, pending, await this.context(calendar));
    return objects.get(objectName) ?? null;
  }

  /** Journals an op; the caller then submits `actionId` to the approval queue. */
  recordPending(calendar: CalendarRecord, objectName: string, op: EventOp): number {
    const actionId = nextActionId(this.#kv);
    putPending(this.#kv, actionId, { calendarId: calendar.id, objectName, op });
    return actionId;
  }

  /**
   * Performs an approved op against the server's current copy. The journal entry is deleted only
   * after the write succeeds, so a failed apply stays approvable. One retry absorbs a concurrent
   * edit between our GET and PUT (a 412 on the conditional write).
   */
  async apply(actionId: number): Promise<void> {
    const record = getPending(this.#kv, actionId);
    if (!record) throw new Error(`Unknown pending calendar action: ${actionId}`);
    const calendar = await this.calendar(record.calendarId);
    const context = await this.context(calendar);
    const url = objectUrl(calendar.url, record.objectName);

    for (let attempt = 0; ; attempt++) {
      try {
        await this.#call(async grant => {
          if (record.op.kind === "create") {
            const next = applyOp(null, record.op, context)!;
            await putObject(url, next, { create: true }, grant, this.#fetch);
            return;
          }
          const current = await getObject(url, grant, this.#fetch);
          if (!current) {
            if (record.op.kind === "delete") return; // already gone
            const createPending = listPending(this.#kv, calendar.id).some(({ actionId: id, record: other }) =>
              id < actionId && other.objectName === record.objectName && other.op.kind === "create");
            throw new CalDavError("RESOURCE_NOT_FOUND", createPending
              ? "This event has not been created yet. Approve its creation first, then this change."
              : "This event no longer exists on the calendar.");
          }
          const next = applyOp(current.data, record.op, context);
          if (next === null) await deleteObject(url, current.etag, grant, this.#fetch);
          else await putObject(url, next, { ifMatch: current.etag }, grant, this.#fetch);
        });
        break;
      } catch (error) {
        if (attempt === 0 && error instanceof CalDavError && error.code === "CONFLICT" && record.op.kind !== "create") continue;
        throw error;
      }
    }
    deletePending(this.#kv, actionId);
  }

  reject(actionId: number): void {
    deletePending(this.#kv, actionId);
  }
}
