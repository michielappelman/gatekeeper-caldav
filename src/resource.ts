/**
 * The two grantable resources — a connected account's whole set of calendars, or one calendar —
 * and the parser for their canonical URLs.
 *
 * CalDAV servers live on arbitrary hosts, and the binding already belongs to one connected account,
 * so resource URLs use a fixed synthetic host (like gatekeeper-homeassistant's
 * `homeassistant.local`) rather than the server's. A `urlPattern` is permanent identity: never
 * change one after deploy.
 */

import type { SupportedResource } from "@gadgets/workshop-shared/gatekeeper";
import { CalDavError } from "./errors";

const RESOURCE_ORIGIN = "https://caldav.local";

// Inline calendar glyph, so the gatekeeper needs no hosted asset.
const CALENDAR_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">\
<rect x="3" y="4.5" width="18" height="16" rx="2.5" fill="#fff" stroke="#e5484d" stroke-width="1.5"/>\
<path d="M3 9h18" stroke="#e5484d" stroke-width="1.5"/>\
<path d="M8 3v3M16 3v3" stroke="#e5484d" stroke-width="1.5" stroke-linecap="round"/>\
<circle cx="8" cy="13" r="1" fill="#e5484d"/><circle cx="12" cy="13" r="1" fill="#e5484d"/>\
<circle cx="16" cy="13" r="1" fill="#e5484d"/><circle cx="8" cy="17" r="1" fill="#e5484d"/>\
<circle cx="12" cy="17" r="1" fill="#e5484d"/>\
</svg>`;
export const CALDAV_LOGO_URL = `data:image/svg+xml;utf8,${encodeURIComponent(CALENDAR_ICON_SVG)}`;

export const CALDAV_CALENDAR_RESOURCE: SupportedResource = {
  urlPattern: `${RESOURCE_ORIGIN}/calendar/:calendarId`,
  title: "Calendar",
  description: "Read and manage events on one calendar you choose.",
  icon: { url: CALDAV_LOGO_URL },
};

export const CALDAV_ACCOUNT_RESOURCE: SupportedResource = {
  urlPattern: `${RESOURCE_ORIGIN}/account`,
  title: "All calendars",
  description:
    "Read events and busy time across every calendar of the connected account, and manage events " +
    "on any of them.",
  icon: { url: CALDAV_LOGO_URL },
};

export const SUPPORTED_RESOURCES: SupportedResource[] = [CALDAV_CALENDAR_RESOURCE, CALDAV_ACCOUNT_RESOURCE];

export type ResourceTarget = { kind: "account" } | { kind: "calendar"; calendarId: string };

export function toAccountResourceUrl(): string {
  return `${RESOURCE_ORIGIN}/account`;
}

export function toCalendarResourceUrl(calendarId: string): string {
  return `${RESOURCE_ORIGIN}/calendar/${encodeURIComponent(calendarId)}`;
}

export function toResourceUrl(target: ResourceTarget): string {
  return target.kind === "account" ? toAccountResourceUrl() : toCalendarResourceUrl(target.calendarId);
}

/** Parses a bound resource URL. Throws `INVALID_RESOURCE` on anything else. */
export function parseResourceUrl(url: string): ResourceTarget {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CalDavError("INVALID_RESOURCE", "Not a valid resource URL.");
  }
  if (parsed.origin !== RESOURCE_ORIGIN || parsed.search || parsed.hash) {
    throw new CalDavError("INVALID_RESOURCE", `CalDAV resource URLs must start with ${RESOURCE_ORIGIN}/.`);
  }
  if (parsed.pathname === "/account") return { kind: "account" };
  const match = /^\/calendar\/([^/]+)$/.exec(parsed.pathname);
  if (match) {
    let calendarId: string;
    try {
      calendarId = decodeURIComponent(match[1]);
    } catch {
      throw new CalDavError("INVALID_RESOURCE", "Malformed calendar id in resource URL.");
    }
    if (calendarId && !calendarId.includes("/")) return { kind: "calendar", calendarId };
  }
  throw new CalDavError("INVALID_RESOURCE", `Unsupported CalDAV resource URL: ${parsed.pathname}`);
}
