/**
 * RRULE (RFC 5545 §3.3.10) parsing and expansion. Expansion runs on wall-clock dates in the event's
 * own zone, so a weekly 09:00 meeting stays at 09:00 across DST changes.
 *
 * Supported: FREQ=DAILY/WEEKLY/MONTHLY/YEARLY with INTERVAL, COUNT, UNTIL, BYDAY (with ordinals for
 * MONTHLY, and YEARLY with BYMONTH), BYMONTHDAY, BYMONTH, and WKST. Rules using anything else
 * (BYSETPOS, BYYEARDAY, BYWEEKNO, BYHOUR/BYMINUTE/BYSECOND, sub-daily FREQ) are marked
 * unsupported; callers then show only the series' first occurrence and any explicit RDATEs.
 */

import { CalDavError } from "./errors";
import { toEpochMs, type ICalDateTime } from "./ical";

export const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export type Frequency = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

export type RRule = {
  freq: Frequency;
  interval: number;
  count?: number;
  until?: ICalDateTime;
  byDay?: { ordinal?: number; weekday: Weekday }[];
  byMonthDay?: number[];
  byMonth?: number[];
  weekStart: Weekday;
  /** False when the rule uses parts this module cannot expand. */
  supported: boolean;
};

const UNSUPPORTED_PARTS = new Set(["BYSETPOS", "BYYEARDAY", "BYWEEKNO", "BYHOUR", "BYMINUTE", "BYSECOND"]);

function parseIntList(value: string): number[] {
  return value.split(",").map(part => Number.parseInt(part, 10)).filter(Number.isFinite);
}

/** Parses an RRULE value. `parseUntil` turns the UNTIL value into a date/date-time. */
export function parseRRule(value: string, parseUntil: (raw: string) => ICalDateTime): RRule {
  const parts = new Map<string, string>();
  for (const part of value.split(";")) {
    const [key, ...rest] = part.split("=");
    if (key) parts.set(key.trim().toUpperCase(), rest.join("=").trim());
  }
  const freqRaw = parts.get("FREQ")?.toUpperCase();
  const freqSupported = freqRaw === "DAILY" || freqRaw === "WEEKLY" || freqRaw === "MONTHLY" || freqRaw === "YEARLY";
  const rule: RRule = {
    freq: freqSupported ? freqRaw : "DAILY",
    interval: Math.max(1, Number.parseInt(parts.get("INTERVAL") ?? "1", 10) || 1),
    weekStart: (WEEKDAYS as readonly string[]).includes(parts.get("WKST") ?? "")
      ? parts.get("WKST") as Weekday : "MO",
    supported: freqSupported,
  };
  for (const key of parts.keys()) if (UNSUPPORTED_PARTS.has(key)) rule.supported = false;

  const count = parts.get("COUNT");
  if (count) rule.count = Math.max(0, Number.parseInt(count, 10) || 0);
  const until = parts.get("UNTIL");
  if (until) rule.until = parseUntil(until);
  const byMonthDay = parts.get("BYMONTHDAY");
  if (byMonthDay) rule.byMonthDay = parseIntList(byMonthDay).filter(day => day !== 0 && Math.abs(day) <= 31);
  const byMonth = parts.get("BYMONTH");
  if (byMonth) rule.byMonth = parseIntList(byMonth).filter(month => month >= 1 && month <= 12);
  const byDay = parts.get("BYDAY");
  if (byDay) {
    rule.byDay = [];
    for (const entry of byDay.split(",")) {
      const match = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(entry.trim());
      if (!match) {
        rule.supported = false;
        continue;
      }
      const ordinal = match[1] ? Number.parseInt(match[1], 10) : undefined;
      rule.byDay.push({ ordinal, weekday: match[2].toUpperCase() as Weekday });
      // Ordinals only make sense within a month here; a year-wide "20th Monday" is not supported.
      if (ordinal !== undefined && !(rule.freq === "MONTHLY" || (rule.freq === "YEARLY" && rule.byMonth))) {
        rule.supported = false;
      }
    }
  }
  return rule;
}

/** Serializes a rule built by `CalDavRecurrence` input (only the parts this module writes). */
export function formatRRule(rule: {
  freq: Frequency; interval?: number; byDay?: Weekday[]; until?: string; count?: number;
}): string {
  const parts = [`FREQ=${rule.freq}`];
  if (rule.interval && rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.byDay?.length) parts.push(`BYDAY=${rule.byDay.join(",")}`);
  if (rule.until) parts.push(`UNTIL=${rule.until}`);
  if (rule.count) parts.push(`COUNT=${rule.count}`);
  return parts.join(";");
}

// ---------------------------------------------------------------------------
// Expansion

type SimpleDate = { year: number; month: number; day: number };

function dayNumber(date: SimpleDate): number {
  return Math.floor(Date.UTC(date.year, date.month - 1, date.day) / 86_400_000);
}

function fromDayNumber(days: number): SimpleDate {
  const date = new Date(days * 86_400_000);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function weekdayOf(date: SimpleDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Candidate days of one month for MONTHLY rules (and YEARLY rules within a BYMONTH month). */
function monthCandidates(year: number, month: number, rule: RRule, startDay: number): number[] {
  const length = daysInMonth(year, month);
  let days: number[] | undefined;
  if (rule.byMonthDay) {
    days = rule.byMonthDay.map(day => (day > 0 ? day : length + day + 1)).filter(day => day >= 1 && day <= length);
  }
  if (rule.byDay) {
    const fromByDay = new Set<number>();
    const firstWeekday = weekdayOf({ year, month, day: 1 });
    for (const { ordinal, weekday } of rule.byDay) {
      const target = WEEKDAYS.indexOf(weekday);
      const first = 1 + ((target - firstWeekday + 7) % 7);
      const matching: number[] = [];
      for (let day = first; day <= length; day += 7) matching.push(day);
      if (ordinal === undefined) matching.forEach(day => fromByDay.add(day));
      else {
        const pick = ordinal > 0 ? matching[ordinal - 1] : matching[matching.length + ordinal];
        if (pick !== undefined) fromByDay.add(pick);
      }
    }
    days = days ? days.filter(day => fromByDay.has(day)) : [...fromByDay];
  }
  if (!days) days = startDay <= length ? [startDay] : [];
  return [...new Set(days)].toSorted((a, b) => a - b);
}

function candidatesForPeriod(rule: RRule, start: SimpleDate, period: number): SimpleDate[] {
  const out: SimpleDate[] = [];
  switch (rule.freq) {
    case "DAILY": {
      const date = fromDayNumber(dayNumber(start) + period * rule.interval);
      const weekday = WEEKDAYS[weekdayOf(date)];
      if (rule.byMonth && !rule.byMonth.includes(date.month)) break;
      if (rule.byDay && !rule.byDay.some(entry => entry.weekday === weekday)) break;
      if (rule.byMonthDay) {
        const length = daysInMonth(date.year, date.month);
        if (!rule.byMonthDay.some(day => (day > 0 ? day : length + day + 1) === date.day)) break;
      }
      out.push(date);
      break;
    }
    case "WEEKLY": {
      const weekStartIndex = WEEKDAYS.indexOf(rule.weekStart);
      const startDays = dayNumber(start);
      const offsetIntoWeek = (weekdayOf(start) - weekStartIndex + 7) % 7;
      const weekBegin = startDays - offsetIntoWeek + period * 7 * rule.interval;
      const weekdays = rule.byDay?.map(entry => WEEKDAYS.indexOf(entry.weekday)) ?? [weekdayOf(start)];
      for (const weekday of new Set(weekdays)) {
        const date = fromDayNumber(weekBegin + ((weekday - weekStartIndex + 7) % 7));
        if (rule.byMonth && !rule.byMonth.includes(date.month)) continue;
        out.push(date);
      }
      out.sort((a, b) => dayNumber(a) - dayNumber(b)); // local scratch array
      break;
    }
    case "MONTHLY": {
      const monthIndex = start.year * 12 + (start.month - 1) + period * rule.interval;
      const year = Math.floor(monthIndex / 12);
      const month = (monthIndex % 12) + 1;
      if (rule.byMonth && !rule.byMonth.includes(month)) break;
      for (const day of monthCandidates(year, month, rule, start.day)) out.push({ year, month, day });
      break;
    }
    case "YEARLY": {
      const year = start.year + period * rule.interval;
      const months = rule.byMonth ?? [start.month];
      const byDayOnly = !rule.byMonth && !rule.byMonthDay && !rule.byDay;
      for (const month of months.toSorted((a, b) => a - b)) {
        const days = byDayOnly
          ? (start.day <= daysInMonth(year, month) ? [start.day] : [])
          : monthCandidates(year, month, rule, start.day);
        for (const day of days) out.push({ year, month, day });
      }
      break;
    }
  }
  return out;
}

/** 14h: the widest UTC offset, so a wall-clock comparison +/- this bound is always conservative. */
const MAX_OFFSET_MS = 14 * 3_600_000;
const MAX_PERIODS = 200_000;

export type ExpandOptions = {
  start: ICalDateTime;
  rule: RRule;
  /** Zone used for dates and floating times. */
  defaultTz: string;
  /** Instances starting after this instant are not generated. */
  windowEndMs: number;
  /** Instances ending before this instant are skipped (but still count toward COUNT). */
  windowStartMs: number;
  durationMs: number;
};

function withDate(start: ICalDateTime, date: SimpleDate): ICalDateTime {
  if (start.kind === "date") return { kind: "date", ...date };
  return { kind: "dateTime", local: { ...start.local, ...date }, zone: start.zone };
}

function approxMs(value: ICalDateTime): number {
  return value.kind === "date"
    ? Date.UTC(value.year, value.month - 1, value.day)
    : Date.UTC(value.local.year, value.local.month - 1, value.local.day, value.local.hour, value.local.minute, value.local.second);
}

/**
 * Instance starts of a recurring event that may overlap the window, in order. Includes the series'
 * own DTSTART as the first instance, as RFC 5545 requires, whether or not it matches the rule.
 * Callers must still filter by exact overlap, apply EXDATEs, and merge RDATEs.
 */
export function expandRecurrence(options: ExpandOptions): ICalDateTime[] {
  const { start, rule, defaultTz } = options;
  const results: ICalDateTime[] = [];
  const mayOverlap = (value: ICalDateTime) =>
    approxMs(value) + options.durationMs + MAX_OFFSET_MS >= options.windowStartMs;

  if (mayOverlap(start) && approxMs(start) - MAX_OFFSET_MS <= options.windowEndMs) results.push(start);
  if (!rule.supported) return results;

  let untilMs: number | undefined;
  if (rule.until) {
    untilMs = rule.until.kind === "date"
      ? toEpochMs({ ...rule.until }, defaultTz) + 86_400_000 - 1
      : toEpochMs(rule.until, defaultTz);
  }

  const startDate: SimpleDate = start.kind === "date"
    ? { year: start.year, month: start.month, day: start.day }
    : { year: start.local.year, month: start.local.month, day: start.local.day };
  const startDayNumber = dayNumber(startDate);
  let emitted = 1;

  for (let period = 0; period < MAX_PERIODS; period++) {
    for (const date of candidatesForPeriod(rule, startDate, period)) {
      if (dayNumber(date) <= startDayNumber) continue;
      const instance = withDate(start, date);
      const approx = approxMs(instance);
      if (approx - MAX_OFFSET_MS > options.windowEndMs) return results;
      if (untilMs !== undefined && approx - MAX_OFFSET_MS > untilMs) return results;
      if (untilMs !== undefined && approx + MAX_OFFSET_MS > untilMs && toEpochMs(instance, defaultTz) > untilMs) {
        return results;
      }
      if (rule.count !== undefined && emitted >= rule.count) return results;
      emitted++;
      if (mayOverlap(instance)) results.push(instance);
    }
  }
  throw new CalDavError("TOO_MANY_EVENTS", "A repeating event has too many occurrences to expand.");
}

const WEEKDAY_NAMES: Record<Weekday, string> = {
  MO: "Monday", TU: "Tuesday", WE: "Wednesday", TH: "Thursday", FR: "Friday", SA: "Saturday", SU: "Sunday",
};

function ordinalName(ordinal: number): string {
  if (ordinal === -1) return "last";
  if (ordinal < 0) return `${-ordinal}th-to-last`;
  return ["first", "second", "third", "fourth", "fifth"][ordinal - 1] ?? `${ordinal}th`;
}

/** A human-readable summary of a rule, e.g. "Every 2 weeks on Monday, Wednesday, 10 times". */
export function describeRRule(rule: RRule, formatUntil: (until: ICalDateTime) => string): string {
  if (!rule.supported) return "Repeats on an irregular pattern (only some occurrences are shown)";
  const unit = { DAILY: "day", WEEKLY: "week", MONTHLY: "month", YEARLY: "year" }[rule.freq];
  let text = rule.interval === 1
    ? { DAILY: "Daily", WEEKLY: "Weekly", MONTHLY: "Monthly", YEARLY: "Yearly" }[rule.freq]
    : `Every ${rule.interval} ${unit}s`;
  if (rule.byDay?.length) {
    text += " on " + rule.byDay.map(entry =>
      entry.ordinal === undefined ? WEEKDAY_NAMES[entry.weekday]
        : `the ${ordinalName(entry.ordinal)} ${WEEKDAY_NAMES[entry.weekday]}`).join(", ");
  } else if (rule.byMonthDay?.length) {
    text += " on day " + rule.byMonthDay.join(", ");
  }
  if (rule.byMonth?.length && rule.freq !== "YEARLY") {
    text += ` (months ${rule.byMonth.join(", ")})`;
  } else if (rule.byMonth?.length) {
    text += " in " + rule.byMonth.map(month =>
      new Date(Date.UTC(2000, month - 1, 1)).toLocaleString("en-US", { month: "long", timeZone: "UTC" })).join(", ");
  }
  if (rule.until) text += `, until ${formatUntil(rule.until)}`;
  if (rule.count) text += `, ${rule.count} times`;
  return text;
}
