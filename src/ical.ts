/**
 * A minimal, lossless iCalendar (RFC 5545) reader/writer. Components and properties are kept as
 * parsed — including every property this gatekeeper does not understand (X-APPLE-*, VTIMEZONE
 * bodies, attachments, …) — so an edit rewrites only the properties it touches and a PUT round-trips
 * the rest of the object unchanged.
 */

import { CalDavError } from "./errors";
import { normalizeTzid, zonedToUtc, type LocalDateTime } from "./timezone";

export type ICalProperty = {
  name: string;
  /** Parameter values with surrounding quotes removed. Multi-valued parameters stay comma-joined. */
  params: Record<string, string>;
  /** The raw (still escaped) value. Use `unescapeText()` for TEXT values. */
  value: string;
};

export type ICalComponent = {
  name: string;
  properties: ICalProperty[];
  components: ICalComponent[];
};

function malformed(detail: string): CalDavError {
  return new CalDavError("UPSTREAM_UNAVAILABLE", `The server returned malformed calendar data: ${detail}`);
}

function parseContentLine(line: string): ICalProperty {
  let index = 0;
  const readUntil = (stops: string): string => {
    let out = "";
    let quoted = false;
    while (index < line.length) {
      const char = line[index];
      if (char === "\"") quoted = !quoted;
      else if (!quoted && stops.includes(char)) break;
      out += char;
      index++;
    }
    return out;
  };

  const name = readUntil(";:").toUpperCase();
  const params: Record<string, string> = {};
  while (line[index] === ";") {
    index++;
    const paramName = readUntil("=;:").toUpperCase();
    let paramValue = "";
    if (line[index] === "=") {
      index++;
      paramValue = readUntil(";:");
    }
    params[paramName] = paramValue.replace(/"/g, "");
  }
  if (line[index] !== ":") throw malformed(`missing ':' in a ${name || "content"} line`);
  return { name, params, value: line.slice(index + 1) };
}

/** Parses an iCalendar stream and returns its top-level component (normally VCALENDAR). */
export function parseICalendar(text: string): ICalComponent {
  const lines = text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const root: ICalComponent = { name: "", properties: [], components: [] };
  const stack: ICalComponent[] = [root];
  for (const line of lines) {
    if (line.trim() === "") continue;
    const property = parseContentLine(line);
    const current = stack[stack.length - 1];
    if (property.name === "BEGIN") {
      const component: ICalComponent = { name: property.value.toUpperCase(), properties: [], components: [] };
      current.components.push(component);
      stack.push(component);
    } else if (property.name === "END") {
      if (stack.length === 1 || current.name !== property.value.toUpperCase()) {
        throw malformed(`unexpected END:${property.value}`);
      }
      stack.pop();
    } else {
      current.properties.push(property);
    }
  }
  if (stack.length !== 1) throw malformed(`unterminated ${stack[stack.length - 1].name}`);
  const calendar = root.components.find(component => component.name === "VCALENDAR");
  if (!calendar) throw malformed("no VCALENDAR component");
  return calendar;
}

function formatParamValue(value: string): string {
  return /[;:,]/.test(value) ? `"${value}"` : value;
}

const encoder = new TextEncoder();

/** Folds one content line to at most 75 octets per physical line, never splitting a character. */
function foldLine(line: string): string {
  if (encoder.encode(line).length <= 75) return line;
  const out: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const char of line) {
    const bytes = encoder.encode(char).length;
    const limit = out.length === 0 ? 75 : 74; // continuation lines start with a space
    if (currentBytes + bytes > limit) {
      out.push(current);
      current = "";
      currentBytes = 0;
    }
    current += char;
    currentBytes += bytes;
  }
  out.push(current);
  return out.join("\r\n ");
}

function serializeInto(component: ICalComponent, lines: string[]): void {
  lines.push(`BEGIN:${component.name}`);
  for (const property of component.properties) {
    const params = Object.entries(property.params)
      .map(([name, value]) => `;${name}=${formatParamValue(value)}`).join("");
    lines.push(foldLine(`${property.name}${params}:${property.value}`));
  }
  for (const child of component.components) serializeInto(child, lines);
  lines.push(`END:${component.name}`);
}

/** Serializes a component tree as a CRLF-terminated iCalendar stream. */
export function serializeICalendar(calendar: ICalComponent): string {
  const lines: string[] = [];
  serializeInto(calendar, lines);
  return `${lines.join("\r\n")}\r\n`;
}

/** Parses unfolded lines (as produced by `buildVTimezone`) into a component. */
export function componentFromLines(lines: string[]): ICalComponent {
  const parsed = parseICalendar(["BEGIN:VCALENDAR", ...lines, "END:VCALENDAR"].join("\r\n"));
  return parsed.components[0];
}

// ---------------------------------------------------------------------------
// Property access

export function getProperty(component: ICalComponent, name: string): ICalProperty | undefined {
  return component.properties.find(property => property.name === name);
}

export function getProperties(component: ICalComponent, name: string): ICalProperty[] {
  return component.properties.filter(property => property.name === name);
}

export function removeProperties(component: ICalComponent, name: string): void {
  component.properties = component.properties.filter(property => property.name !== name);
}

/** Replaces every `name` property with a single one (or removes them all when `value` is null). */
export function setProperty(
  component: ICalComponent, name: string, value: string | null, params: Record<string, string> = {},
): void {
  const index = component.properties.findIndex(property => property.name === name);
  removeProperties(component, name);
  if (value === null) return;
  const property = { name, params, value };
  if (index === -1) component.properties.push(property);
  else component.properties.splice(index, 0, property);
}

export function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_, char: string) => (char === "n" || char === "N" ? "\n" : char));
}

export function escapeText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** A TEXT property's unescaped value, or undefined when absent or empty. */
export function getText(component: ICalComponent, name: string): string | undefined {
  const property = getProperty(component, name);
  if (!property) return undefined;
  const value = unescapeText(property.value);
  return value === "" ? undefined : value;
}

// ---------------------------------------------------------------------------
// DATE / DATE-TIME values

export type ICalZone = { type: "utc" } | { type: "tz"; tzid: string } | { type: "floating" };

export type ICalDateTime =
  | { kind: "date"; year: number; month: number; day: number }
  | { kind: "dateTime"; local: LocalDateTime; zone: ICalZone };

const DATE_RE = /^(\d{4})(\d{2})(\d{2})$/;
const DATE_TIME_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/;

function parseOneDateTime(value: string, tzid: string | undefined, forceDate: boolean): ICalDateTime {
  const trimmed = value.trim();
  const dateMatch = DATE_RE.exec(trimmed);
  if (dateMatch || forceDate) {
    if (!dateMatch) throw malformed(`bad DATE value "${trimmed}"`);
    return { kind: "date", year: +dateMatch[1], month: +dateMatch[2], day: +dateMatch[3] };
  }
  const match = DATE_TIME_RE.exec(trimmed);
  if (!match) throw malformed(`bad DATE-TIME value "${trimmed}"`);
  const local = {
    year: +match[1], month: +match[2], day: +match[3],
    hour: +match[4], minute: +match[5], second: Math.min(+match[6], 59),
  };
  let zone: ICalZone = { type: "floating" };
  if (match[7] === "Z") zone = { type: "utc" };
  else if (tzid) {
    const normalized = normalizeTzid(tzid);
    // An unrecognized TZID is read as floating time, i.e. in the calendar's own zone.
    if (normalized) zone = normalized === "UTC" ? { type: "utc" } : { type: "tz", tzid: normalized };
  }
  return { kind: "dateTime", local, zone };
}

/** Parses a DTSTART/DTEND/RECURRENCE-ID-style property. */
export function parseDateTimeProperty(property: ICalProperty): ICalDateTime {
  return parseOneDateTime(property.value, property.params.TZID, property.params.VALUE === "DATE");
}

/** Parses a multi-valued EXDATE/RDATE-style property. PERIOD values are skipped. */
export function parseDateTimeList(property: ICalProperty): ICalDateTime[] {
  if (property.params.VALUE === "PERIOD") return [];
  return property.value.split(",").filter(Boolean)
    .map(value => parseOneDateTime(value, property.params.TZID, property.params.VALUE === "DATE"));
}

/** The instant a value denotes. Dates and floating times are read in `defaultTz`. */
export function toEpochMs(value: ICalDateTime, defaultTz: string): number {
  if (value.kind === "date") {
    return zonedToUtc({ year: value.year, month: value.month, day: value.day, hour: 0, minute: 0, second: 0 }, defaultTz);
  }
  if (value.zone.type === "utc") return zonedToUtc(value.local, "UTC");
  return zonedToUtc(value.local, value.zone.type === "tz" ? value.zone.tzid : defaultTz);
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

export function formatDate(year: number, month: number, day: number): string {
  return `${pad(year, 4)}${pad(month)}${pad(day)}`;
}

export function formatLocal(local: LocalDateTime): string {
  return `${formatDate(local.year, local.month, local.day)}T${pad(local.hour)}${pad(local.minute)}${pad(local.second)}`;
}

/** Formats a value as a property value plus the params (VALUE/TZID) it needs. */
export function formatDateTime(value: ICalDateTime): { value: string; params: Record<string, string> } {
  if (value.kind === "date") {
    return { value: formatDate(value.year, value.month, value.day), params: { VALUE: "DATE" } };
  }
  if (value.zone.type === "utc") return { value: `${formatLocal(value.local)}Z`, params: {} };
  if (value.zone.type === "tz") return { value: formatLocal(value.local), params: { TZID: value.zone.tzid } };
  return { value: formatLocal(value.local), params: {} };
}

/** A stable key for an instance start, used to match RECURRENCE-IDs and EXDATEs to occurrences. */
export function instanceKey(value: ICalDateTime, defaultTz: string): string {
  if (value.kind === "date") return formatDate(value.year, value.month, value.day);
  const date = new Date(toEpochMs(value, defaultTz));
  return `${formatDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate())}T` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

/** Current time as a UTC DATE-TIME value (for DTSTAMP/LAST-MODIFIED). */
export function utcStamp(now: number): string {
  const date = new Date(now);
  return `${formatDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate())}T` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

// ---------------------------------------------------------------------------
// DURATION values

const DURATION_RE = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

/** Parses an RFC 5545 DURATION into signed milliseconds, or undefined if malformed. */
export function parseDuration(value: string): number | undefined {
  const match = DURATION_RE.exec(value.trim());
  if (!match) return undefined;
  const [, sign, weeks, days, hours, minutes, seconds] = match;
  const ms = ((+(weeks ?? 0) * 7 + +(days ?? 0)) * 86_400 + +(hours ?? 0) * 3600 +
    +(minutes ?? 0) * 60 + +(seconds ?? 0)) * 1000;
  return sign === "-" ? -ms : ms;
}

/** Formats a whole number of minutes before a start as a negative DURATION (`-PT15M`). */
export function formatMinutesBefore(minutes: number): string {
  if (minutes === 0) return "PT0S";
  const days = Math.floor(minutes / 1440);
  const rest = minutes % 1440;
  const hours = Math.floor(rest / 60);
  const mins = rest % 60;
  const time = (hours ? `${hours}H` : "") + (mins ? `${mins}M` : "");
  return `-P${days ? `${days}D` : ""}${time ? `T${time}` : ""}`;
}
