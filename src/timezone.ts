/**
 * Wall-clock <-> instant conversion for IANA time zones, using only `Intl` (Workers ship full ICU
 * data, so no tz database needs bundling), plus generation of the VTIMEZONE component RFC 5545
 * requires beside every TZID a new event references.
 */

/** A wall-clock date/time with no zone attached. `month` is 1-12. */
export type LocalDateTime = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "numeric", second: "numeric",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** True if `timeZone` is an IANA name this runtime can convert (e.g. `Europe/Amsterdam`, `UTC`). */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** Windows zone names Outlook/Exchange write as TZIDs, for the most common zones. */
const WINDOWS_ZONES: Record<string, string> = {
  "W. Europe Standard Time": "Europe/Berlin",
  "Romance Standard Time": "Europe/Paris",
  "Central Europe Standard Time": "Europe/Budapest",
  "Central European Standard Time": "Europe/Warsaw",
  "GMT Standard Time": "Europe/London",
  "Greenwich Standard Time": "Atlantic/Reykjavik",
  "FLE Standard Time": "Europe/Helsinki",
  "GTB Standard Time": "Europe/Bucharest",
  "E. Europe Standard Time": "Europe/Chisinau",
  "Russian Standard Time": "Europe/Moscow",
  "Eastern Standard Time": "America/New_York",
  "Central Standard Time": "America/Chicago",
  "Mountain Standard Time": "America/Denver",
  "US Mountain Standard Time": "America/Phoenix",
  "Pacific Standard Time": "America/Los_Angeles",
  "Alaskan Standard Time": "America/Anchorage",
  "Hawaiian Standard Time": "Pacific/Honolulu",
  "Atlantic Standard Time": "America/Halifax",
  "India Standard Time": "Asia/Kolkata",
  "China Standard Time": "Asia/Shanghai",
  "Tokyo Standard Time": "Asia/Tokyo",
  "Singapore Standard Time": "Asia/Singapore",
  "AUS Eastern Standard Time": "Australia/Sydney",
  "New Zealand Standard Time": "Pacific/Auckland",
  "UTC": "UTC",
};

/**
 * Maps a TZID as found in the wild to an IANA name, or undefined if unrecognized. Accepts plain IANA
 * names, the `/vendor.example/.../Europe/Berlin` prefixed form some clients write, and common
 * Windows zone names.
 */
export function normalizeTzid(tzid: string): string | undefined {
  const trimmed = tzid.trim().replace(/^"|"$/g, "");
  if (WINDOWS_ZONES[trimmed]) return WINDOWS_ZONES[trimmed];
  if (isValidTimeZone(trimmed)) return trimmed;
  const match = /([A-Za-z_]+\/[A-Za-z_+-]+(?:\/[A-Za-z_+-]+)?)$/.exec(trimmed);
  if (match && isValidTimeZone(match[1])) return match[1];
  return undefined;
}

/** Wall-clock fields of instant `epochMs` in `timeZone`. */
export function utcToZoned(epochMs: number, timeZone: string): LocalDateTime {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(epochMs))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year, month: parts.month, day: parts.day,
    hour: parts.hour, minute: parts.minute, second: parts.second,
  };
}

function localAsUtcMs(local: LocalDateTime): number {
  return Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
}

/** Offset of `timeZone` from UTC at instant `epochMs`, in milliseconds (east positive). */
export function offsetMs(epochMs: number, timeZone: string): number {
  const whole = Math.floor(epochMs / 1000) * 1000;
  return localAsUtcMs(utcToZoned(whole, timeZone)) - whole;
}

/**
 * The instant at which `timeZone`'s wall clock reads `local`. A wall time skipped by a DST jump
 * resolves to the instant just after the jump; an ambiguous one (repeated hour) to the first.
 */
export function zonedToUtc(local: LocalDateTime, timeZone: string): number {
  const asUtc = localAsUtcMs(local);
  const first = asUtc - offsetMs(asUtc, timeZone);
  const second = asUtc - offsetMs(first, timeZone);
  if (first === second) return first;
  // Around a transition the two guesses disagree; prefer the earlier one that round-trips.
  const candidates = [Math.min(first, second), Math.max(first, second)];
  for (const candidate of candidates) {
    if (localAsUtcMs(utcToZoned(candidate, timeZone)) === asUtc) return candidate;
  }
  return Math.max(first, second);
}

// ---------------------------------------------------------------------------
// VTIMEZONE generation

type Transition = { atMs: number; fromOffset: number; toOffset: number };

function transitionsInYear(timeZone: string, year: number): Transition[] {
  const result: Transition[] = [];
  const dayMs = 86_400_000;
  let previousAt = Date.UTC(year, 0, 1);
  let previousOffset = offsetMs(previousAt, timeZone);
  for (let at = previousAt + dayMs; at <= Date.UTC(year + 1, 0, 1); at += dayMs) {
    const offset = offsetMs(at, timeZone);
    if (offset !== previousOffset) {
      // Bisect to the minute at which the offset changed.
      let low = previousAt;
      let high = at;
      while (high - low > 60_000) {
        const mid = low + Math.floor((high - low) / 120_000) * 60_000;
        if (offsetMs(mid, timeZone) === previousOffset) low = mid;
        else high = mid;
      }
      result.push({ atMs: high, fromOffset: previousOffset, toOffset: offset });
    }
    previousAt = at;
    previousOffset = offset;
  }
  return result;
}

function formatOffset(ms: number): string {
  const sign = ms < 0 ? "-" : "+";
  const totalMinutes = Math.abs(ms) / 60_000;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${sign}${String(hours).padStart(2, "0")}${String(minutes).padStart(2, "0")}`;
}

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/**
 * Builds a VTIMEZONE (as unfolded iCalendar lines) for `timeZone`, describing the rule in effect in
 * `referenceYear` as yearly nth-weekday rules. That matches how zones with DST are defined today;
 * historical rule changes are not reproduced, since CalDAV servers resolve IANA TZIDs themselves
 * and the component exists to satisfy RFC 5545 and to keep offline clients close to right.
 */
export function buildVTimezone(timeZone: string, referenceYear: number): string[] {
  const lines = ["BEGIN:VTIMEZONE", `TZID:${timeZone}`];
  const transitions = transitionsInYear(timeZone, referenceYear);
  if (transitions.length === 0) {
    const offset = formatOffset(offsetMs(Date.UTC(referenceYear, 0, 1), timeZone));
    lines.push(
      "BEGIN:STANDARD", "DTSTART:19700101T000000", `TZOFFSETFROM:${offset}`,
      `TZOFFSETTO:${offset}`, "END:STANDARD");
  } else {
    for (const transition of transitions) {
      // Onset is expressed in the wall time in effect *before* the transition.
      const local = utcToZoned(transition.atMs + transition.fromOffset, "UTC");
      const weekday = new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay();
      const daysInMonth = new Date(Date.UTC(local.year, local.month, 0)).getUTCDate();
      const ordinal = local.day + 7 > daysInMonth ? -1 : Math.ceil(local.day / 7);
      // First date in 1970 matching the same rule, as the observance's DTSTART.
      const firstOfMonth = new Date(Date.UTC(1970, local.month - 1, 1)).getUTCDay();
      const lastOfMonth = new Date(Date.UTC(1970, local.month, 0)).getUTCDate();
      let day: number;
      if (ordinal === -1) {
        const lastWeekday = new Date(Date.UTC(1970, local.month - 1, lastOfMonth)).getUTCDay();
        day = lastOfMonth - ((lastWeekday - weekday + 7) % 7);
      } else {
        day = 1 + ((weekday - firstOfMonth + 7) % 7) + (ordinal - 1) * 7;
      }
      const kind = transition.toOffset > transition.fromOffset ? "DAYLIGHT" : "STANDARD";
      lines.push(
        `BEGIN:${kind}`,
        `DTSTART:1970${pad(local.month)}${pad(day)}T${pad(local.hour)}${pad(local.minute)}${pad(local.second)}`,
        `RRULE:FREQ=YEARLY;BYMONTH=${local.month};BYDAY=${ordinal}${WEEKDAYS[weekday]}`,
        `TZOFFSETFROM:${formatOffset(transition.fromOffset)}`,
        `TZOFFSETTO:${formatOffset(transition.toOffset)}`,
        `END:${kind}`);
    }
  }
  lines.push("END:VTIMEZONE");
  return lines;
}
