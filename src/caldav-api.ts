/**
 * A direct CalDAV (RFC 4791) client over `fetch()`. No WebDAV/CalDAV library suits Workers, and the
 * subset needed here is small: principal and calendar-home discovery, one PROPFIND to list
 * calendars, one calendar-query REPORT per window, and GET/PUT/DELETE on individual objects.
 *
 * Every function throws `CalDavError`; nothing here knows about sessions or approvals.
 */

import { CalDavError, errorForStatus } from "./errors";
import { utcStamp } from "./ical";
import { isValidObjectName } from "./events";
import { normalizeTzid } from "./timezone";
import {
  APPLE_ICAL_NS,
  CALDAV_NS,
  child,
  children,
  DAV_NS,
  escapeXml,
  parseMultistatus,
  propKey,
  type MultistatusResponse,
} from "./xml";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type Credentials = { username: string; password: string };

/** Where a connected account lives, as discovered at connect time. */
export type AccountInfo = {
  /** Calendar home collection URL; every calendar is a child of it. Ends with `/`. */
  homeUrl: string;
  /** The account's own calendar addresses, lowercase, without `mailto:`. */
  addresses: string[];
  displayName?: string;
};

export type CalendarRecord = {
  /** Last path segment of the calendar collection, decoded. Stable per account. */
  id: string;
  /** Collection URL, ending with `/`. */
  url: string;
  name: string;
  color?: string;
  description?: string;
  timeZone?: string;
  readOnly: boolean;
};

export type CalendarObject = { name: string; etag?: string; data: string };

/** Default server offered on the connect form. */
export const ICLOUD_CALDAV_URL = "https://caldav.icloud.com/";

const MAX_REDIRECTS = 5;

/** Normalizes a user-typed server URL to an `https:` URL with no credentials or fragment. */
export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    throw new CalDavError("INVALID_ARGUMENT", "The server address is not a valid URL.");
  }
  if (url.protocol !== "https:") throw new CalDavError("INVALID_ARGUMENT", "The server address must use https.");
  if (url.username || url.password) {
    throw new CalDavError("INVALID_ARGUMENT", "Enter the username and password in their own fields, not in the URL.");
  }
  url.hash = "";
  return url.toString();
}

function authHeader(credentials: Credentials): string {
  const bytes = new TextEncoder().encode(`${credentials.username}:${credentials.password}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

type DavRequest = {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  /** Statuses that are returned rather than thrown. */
  allow?: number[];
};

/** Sends one request, following https redirects by hand so credentials never go to plain http. */
async function davFetch(request: DavRequest, credentials: Credentials, fetchImpl: FetchLike): Promise<{ response: Response; url: string }> {
  let url = request.url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: request.method,
        headers: { Authorization: authHeader(credentials), ...request.headers },
        body: request.body,
        redirect: "manual",
      });
    } catch (error) {
      throw new CalDavError("UPSTREAM_UNAVAILABLE", "Could not reach the CalDAV server.", { cause: error });
    }
    if (response.status >= 300 && response.status < 400 && response.headers.get("Location")) {
      const next = new URL(response.headers.get("Location")!, url);
      if (next.protocol !== "https:") {
        throw new CalDavError("UPSTREAM_UNAVAILABLE", "The CalDAV server redirected to a non-https address.");
      }
      await response.body?.cancel();
      url = next.toString();
      continue;
    }
    if (!response.ok && !request.allow?.includes(response.status)) {
      await response.body?.cancel();
      throw errorForStatus(response.status);
    }
    return { response, url };
  }
  throw new CalDavError("UPSTREAM_UNAVAILABLE", "The CalDAV server redirected too many times.");
}

async function multistatus(request: DavRequest, credentials: Credentials, fetchImpl: FetchLike): Promise<{ responses: MultistatusResponse[]; url: string }> {
  const { response, url } = await davFetch({
    ...request,
    headers: { "Content-Type": "application/xml; charset=utf-8", ...request.headers },
  }, credentials, fetchImpl);
  if (response.status !== 207) {
    await response.body?.cancel();
    throw new CalDavError("UPSTREAM_UNAVAILABLE", `Expected a multistatus response, got ${response.status}.`);
  }
  return { responses: parseMultistatus(await response.text()), url };
}

function propfindBody(props: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>` +
    `<d:propfind xmlns:d="DAV:" xmlns:c="${CALDAV_NS}" xmlns:a="${APPLE_ICAL_NS}"><d:prop>${props}</d:prop></d:propfind>`;
}

function hrefProp(response: MultistatusResponse | undefined, ns: string, name: string, base: string): string | undefined {
  const href = child(response?.props.get(propKey(ns, name)), DAV_NS, "href")?.text.trim();
  return href ? new URL(href, base).toString() : undefined;
}

function withTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

async function findPrincipal(serverUrl: string, credentials: Credentials, fetchImpl: FetchLike): Promise<string | undefined> {
  const { responses, url } = await multistatus({
    method: "PROPFIND", url: serverUrl, headers: { Depth: "0" },
    body: propfindBody("<d:current-user-principal/>"),
  }, credentials, fetchImpl);
  return hrefProp(responses[0], DAV_NS, "current-user-principal", url);
}

/**
 * Finds the account's calendar home from a server URL (e.g. `https://caldav.icloud.com/`), via
 * `current-user-principal` then `calendar-home-set`, falling back to `/.well-known/caldav`.
 * Also serves as the credential check at connect time.
 */
export async function discoverAccount(serverUrl: string, credentials: Credentials, fetchImpl: FetchLike = fetch): Promise<AccountInfo> {
  let principalUrl: string | undefined;
  try {
    principalUrl = await findPrincipal(serverUrl, credentials, fetchImpl);
  } catch (error) {
    if (error instanceof CalDavError && error.code === "AUTH_EXPIRED") throw error;
  }
  if (!principalUrl) {
    principalUrl = await findPrincipal(new URL("/.well-known/caldav", serverUrl).toString(), credentials, fetchImpl);
  }
  if (!principalUrl) {
    throw new CalDavError("RESOURCE_NOT_FOUND", "This server did not identify a CalDAV account for these credentials.");
  }

  const { responses, url } = await multistatus({
    method: "PROPFIND", url: principalUrl, headers: { Depth: "0" },
    body: propfindBody("<c:calendar-home-set/><c:calendar-user-address-set/><d:displayname/>"),
  }, credentials, fetchImpl);
  const principal = responses[0];
  const homeUrl = hrefProp(principal, CALDAV_NS, "calendar-home-set", url);
  if (!homeUrl) throw new CalDavError("RESOURCE_NOT_FOUND", "This account has no calendars on this server.");
  const addresses = children(principal?.props.get(propKey(CALDAV_NS, "calendar-user-address-set")), DAV_NS, "href")
    .map(href => href.text.trim())
    .filter(href => /^mailto:/i.test(href))
    .map(href => href.replace(/^mailto:/i, "").toLowerCase());
  const displayName = principal?.props.get(propKey(DAV_NS, "displayname"))?.text.trim() || undefined;
  return { homeUrl: withTrailingSlash(homeUrl), addresses: [...new Set(addresses)], displayName };
}

const WRITE_PRIVILEGES = new Set(["all", "write", "write-content"]);

/** Lists the event calendars in a calendar home. */
export async function listCalendars(homeUrl: string, credentials: Credentials, fetchImpl: FetchLike = fetch): Promise<CalendarRecord[]> {
  const { responses, url } = await multistatus({
    method: "PROPFIND", url: homeUrl, headers: { Depth: "1" },
    body: propfindBody(
      "<d:resourcetype/><d:displayname/><d:current-user-privilege-set/><c:supported-calendar-component-set/>" +
      "<c:calendar-description/><c:calendar-timezone/><a:calendar-color/>"),
  }, credentials, fetchImpl);
  const home = new URL(url);
  const calendars: CalendarRecord[] = [];
  for (const response of responses) {
    const collection = new URL(response.href, url);
    if (collection.origin !== home.origin) continue;
    const path = withTrailingSlash(collection.pathname);
    if (path === withTrailingSlash(home.pathname) || !path.startsWith(withTrailingSlash(home.pathname))) continue;
    const resourceType = response.props.get(propKey(DAV_NS, "resourcetype"));
    if (!child(resourceType, CALDAV_NS, "calendar")) continue;
    const components = children(response.props.get(propKey(CALDAV_NS, "supported-calendar-component-set")), CALDAV_NS, "comp")
      .map(comp => comp.attrs.name?.toUpperCase());
    if (components.length > 0 && !components.includes("VEVENT")) continue;

    const segment = path.slice(withTrailingSlash(home.pathname).length).replace(/\/$/, "");
    if (!segment || segment.includes("/")) continue;
    let id: string;
    try {
      id = decodeURIComponent(segment);
    } catch {
      continue;
    }

    const privileges = response.props.get(propKey(DAV_NS, "current-user-privilege-set"));
    const readOnly = privileges !== undefined && !children(privileges, DAV_NS, "privilege")
      .some(privilege => privilege.children.some(entry => entry.ns === DAV_NS && WRITE_PRIVILEGES.has(entry.name)));
    const timezoneText = response.props.get(propKey(CALDAV_NS, "calendar-timezone"))?.text;
    const tzid = timezoneText ? /^TZID[^:]*:(.+)$/m.exec(timezoneText.replace(/\r/g, ""))?.[1] : undefined;
    const color = response.props.get(propKey(APPLE_ICAL_NS, "calendar-color"))?.text.trim();

    calendars.push({
      id,
      url: new URL(path, url).toString(),
      name: response.props.get(propKey(DAV_NS, "displayname"))?.text.trim() || id,
      color: color && /^#[0-9a-fA-F]{6}/.test(color) ? color.slice(0, 7).toLowerCase() : undefined,
      description: response.props.get(propKey(CALDAV_NS, "calendar-description"))?.text.trim() || undefined,
      timeZone: tzid ? normalizeTzid(tzid) : undefined,
      readOnly,
    });
  }
  return calendars.toSorted((a, b) => a.name.localeCompare(b.name));
}

/** The resource name of `href` if it names an object directly inside `calendarUrl`. */
export function objectNameFromHref(href: string, calendarUrl: string): string | undefined {
  const calendar = new URL(calendarUrl);
  const object = new URL(href, calendarUrl);
  if (object.origin !== calendar.origin) return undefined;
  const base = withTrailingSlash(calendar.pathname);
  if (!object.pathname.startsWith(base)) return undefined;
  const name = object.pathname.slice(base.length);
  return isValidObjectName(name) ? name : undefined;
}

/** URL of an object in a calendar. `objectName` must already be validated. */
export function objectUrl(calendarUrl: string, objectName: string): string {
  if (!isValidObjectName(objectName)) throw new CalDavError("INVALID_ARGUMENT", "Not a valid event id.");
  return new URL(objectName, withTrailingSlash(calendarUrl)).toString();
}

/** Every event object in a calendar with an instance overlapping the window. */
export async function queryObjects(
  calendarUrl: string, startMs: number, endMs: number, credentials: Credentials, fetchImpl: FetchLike = fetch,
): Promise<CalendarObject[]> {
  const body = `<?xml version="1.0" encoding="utf-8"?>` +
    `<c:calendar-query xmlns:d="DAV:" xmlns:c="${CALDAV_NS}">` +
    `<d:prop><d:getetag/><c:calendar-data/></d:prop>` +
    `<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">` +
    `<c:time-range start="${escapeXml(utcStamp(startMs))}" end="${escapeXml(utcStamp(endMs))}"/>` +
    `</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
  const { responses } = await multistatus({
    method: "REPORT", url: calendarUrl, headers: { Depth: "1" }, body,
  }, credentials, fetchImpl);
  const objects: CalendarObject[] = [];
  for (const response of responses) {
    const name = objectNameFromHref(response.href, calendarUrl);
    const data = response.props.get(propKey(CALDAV_NS, "calendar-data"))?.text;
    if (!name || !data) continue;
    objects.push({ name, etag: response.props.get(propKey(DAV_NS, "getetag"))?.text.trim() || undefined, data });
  }
  return objects;
}

/** Fetches one object, or null if it does not exist. */
export async function getObject(url: string, credentials: Credentials, fetchImpl: FetchLike = fetch): Promise<{ etag?: string; data: string } | null> {
  const { response } = await davFetch({ method: "GET", url, allow: [404, 410] }, credentials, fetchImpl);
  if (response.status === 404 || response.status === 410) {
    await response.body?.cancel();
    return null;
  }
  return { etag: response.headers.get("ETag") ?? undefined, data: await response.text() };
}

/**
 * Writes an object. `ifMatch` guards an update against a concurrent change; `create` refuses to
 * overwrite an existing object. A 412 surfaces as `CONFLICT`.
 */
export async function putObject(
  url: string, data: string, condition: { ifMatch?: string; create?: boolean },
  credentials: Credentials, fetchImpl: FetchLike = fetch,
): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": "text/calendar; charset=utf-8" };
  if (condition.create) headers["If-None-Match"] = "*";
  else if (condition.ifMatch) headers["If-Match"] = condition.ifMatch;
  const { response } = await davFetch({ method: "PUT", url, headers, body: data }, credentials, fetchImpl);
  await response.body?.cancel();
}

/** Deletes an object; an object that is already gone counts as deleted. */
export async function deleteObject(
  url: string, ifMatch: string | undefined, credentials: Credentials, fetchImpl: FetchLike = fetch,
): Promise<void> {
  const { response } = await davFetch({
    method: "DELETE", url, headers: ifMatch ? { "If-Match": ifMatch } : {}, allow: [404, 410],
  }, credentials, fetchImpl);
  await response.body?.cancel();
}

// ---------------------------------------------------------------------------
// Published calendar links (ICS feeds)
//
// A subscription is an ordinary HTTPS GET of one iCalendar document, with no credentials: the feed
// is world-readable by whoever holds the link. Publishers expect polling, so conditional requests
// (ETag / Last-Modified) are used whenever a cached copy exists.

/** Largest feed body accepted, to bound memory in the Worker. */
export const MAX_FEED_BYTES = 8 * 1024 * 1024;

/** Normalizes a published calendar link. Accepts `webcal:`, which is `https:` by another name. */
export function normalizeFeedUrl(input: string): string {
  // `webcal:` is a non-special scheme, and the URL protocol setter refuses to turn one into
  // `https:`, so the swap happens on the text before parsing.
  const trimmed = input.trim().replace(/^webcal:\/\//i, "https://");
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    throw new CalDavError("INVALID_ARGUMENT", "The calendar link is not a valid URL.");
  }
  if (url.protocol !== "https:") {
    throw new CalDavError("INVALID_ARGUMENT", "The calendar link must use https (or webcal).");
  }
  if (url.username || url.password) {
    throw new CalDavError("INVALID_ARGUMENT", "A published calendar link must not contain a username or password.");
  }
  url.hash = "";
  return url.toString();
}

export type FeedValidators = { etag?: string; lastModified?: string };

export type FeedFetchResult =
  | { status: "notModified" }
  | { status: "ok"; text: string; etag?: string; lastModified?: string };

/** Fetches a published calendar, returning `notModified` when the cached copy is still current. */
export async function fetchIcsFeed(
  url: string, validators: FeedValidators = {}, fetchImpl: FetchLike = fetch,
): Promise<FeedFetchResult> {
  const headers: Record<string, string> = { Accept: "text/calendar, text/plain;q=0.9, */*;q=0.8" };
  if (validators.etag) headers["If-None-Match"] = validators.etag;
  else if (validators.lastModified) headers["If-Modified-Since"] = validators.lastModified;

  let response: Response;
  try {
    response = await fetchImpl(url, { method: "GET", headers, redirect: "follow" });
  } catch (error) {
    throw new CalDavError("UPSTREAM_UNAVAILABLE", "Could not reach the published calendar.", { cause: error });
  }
  if (response.status === 304) {
    await response.body?.cancel();
    return { status: "notModified" };
  }
  if (!response.ok) {
    await response.body?.cancel();
    const error = errorForStatus(response.status);
    // Nobody is signed in to a public link, so 401/403 means the link is not public (or no longer).
    if (response.status === 401 || response.status === 403) {
      throw new CalDavError("FORBIDDEN", "That calendar link is not publicly readable.", { cause: error });
    }
    throw error;
  }

  const declaredLength = Number(response.headers.get("Content-Length") ?? Number.NaN);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_FEED_BYTES) {
    await response.body?.cancel();
    throw new CalDavError("TOO_MANY_EVENTS", "That calendar feed is too large to read.");
  }
  const text = await response.text();
  if (text.length > MAX_FEED_BYTES) {
    throw new CalDavError("TOO_MANY_EVENTS", "That calendar feed is too large to read.");
  }
  if (!/BEGIN:VCALENDAR/i.test(text)) {
    throw new CalDavError(
      "INVALID_ARGUMENT",
      "That link did not return a calendar file. Use the published .ics link, not the web page that shows it.");
  }
  return {
    status: "ok",
    text,
    etag: response.headers.get("ETag") ?? undefined,
    lastModified: response.headers.get("Last-Modified") ?? undefined,
  };
}
