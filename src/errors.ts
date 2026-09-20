/**
 * Stable error codes the rest of the gatekeeper can branch on, independent of the CalDAV server's
 * own HTTP statuses. Every call into `./caldav-api.ts` throws a `CalDavError`, never a raw
 * `Response` or fetch failure.
 */
export type CalDavErrorCode =
  | "AUTH_REQUIRED"
  | "AUTH_EXPIRED"
  | "FORBIDDEN"
  | "RESOURCE_NOT_FOUND"
  | "INVALID_RESOURCE"
  | "INVALID_ARGUMENT"
  | "CONFLICT"
  | "READ_ONLY"
  | "TOO_MANY_EVENTS"
  | "RATE_LIMITED"
  | "UPSTREAM_UNAVAILABLE";

export class CalDavError extends Error {
  constructor(readonly code: CalDavErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CalDavError";
  }
}

/** Classifies a CalDAV HTTP response status into a stable error code. */
export function errorForStatus(status: number): CalDavError {
  if (status === 401) {
    return new CalDavError("AUTH_EXPIRED", "The CalDAV server rejected the stored credentials.");
  }
  if (status === 403) {
    return new CalDavError("FORBIDDEN", "The CalDAV server denied this request.");
  }
  if (status === 404 || status === 410) {
    return new CalDavError("RESOURCE_NOT_FOUND", "The requested calendar resource was not found.");
  }
  if (status === 412) {
    return new CalDavError("CONFLICT", "The event was changed elsewhere in the meantime.");
  }
  if (status === 429) {
    return new CalDavError("RATE_LIMITED", "The CalDAV server is rate-limiting this account.");
  }
  if (status >= 500) {
    return new CalDavError("UPSTREAM_UNAVAILABLE", `The CalDAV server returned an error (${status}).`);
  }
  return new CalDavError("UPSTREAM_UNAVAILABLE", `CalDAV request failed with status ${status}.`);
}
