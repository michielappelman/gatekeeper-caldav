# gatekeeper-caldav

A Cloudflare OS Gatekeeper for iCloud Calendar, any other CalDAV server, and published calendar
links (.ics / webcal feeds), following the upstream
`write-gatekeeper` skill (`cloudflare-os/.agents/skills/write-gatekeeper/SKILL.md`). The
agent-facing API (`src/types.d.ts`) deliberately mirrors upstream's Google Calendar session so
agents see the same shapes across providers.

## Use in another Cloudflare OS starter

This repository is designed to be consumed as a Git submodule by a
[`cloudflare-os-starter`](https://github.com/cloudflare/cloudflare-os-starter)-style deployment.
It is not an npm package: its `@gadgets/*` dependencies are resolved from the pinned Cloudflare OS
workspace in the consuming starter, which keeps the Gatekeeper Kit ABI aligned with the deployment.

From the root of the starter:

```sh
git submodule add https://github.com/michielappelman/gatekeeper-caldav.git packages/gatekeeper-caldav
git submodule update --init --recursive
pnpm install
```

The starter must include `packages/*` in `pnpm-workspace.yaml`, and its deploy wrapper must treat
`packages/gatekeeper-caldav` as the CalDAV Worker package. In practice that means:

1. Read this package's `wrangler.jsonc` as the base CalDAV config.
2. Generate the production config with the deployment's account, Worker name, service bindings,
   `BASE_URL` (`<origin>/gatekeeper/caldav`), and observability settings.
3. Run `vp run -F gatekeeper-caldav --no-cache build` before deploying the Worker.
4. Deploy it before the Workshop and Router, which consume its service binding: on the Workshop
   with the `GatekeeperVendor` entrypoint, on the Router (as `GATEKEEPER_CALDAV`) with none, so the
   connect flow is served at `/gatekeeper/caldav`.
5. Pin the submodule commit in the starter and record that commit in the deployment inventory.

The starter's `workers.caldav.name` is the deployed Worker identity; it need not be
`gatekeeper-caldav`. The public router is the only route: the CalDAV Worker should have no public
or preview URL. Users supply their own credentials (or a public calendar link) through the
Gatekeeper's connect flow, so no deployment-wide CalDAV secret is required.

For local development and tests, run them from the consuming starter after the Cloudflare OS
submodule is initialized (see [Development](#development)).

Keep the Cloudflare OS submodule and this Gatekeeper pinned together. If either changes, run the
Gatekeeper tests, the starter's type checks, and the full starter check before updating the
submodule gitlinks.

## Auth

A connection is one of two kinds, chosen on the connect form.

**A calendar account (CalDAV).** Apple offers no OAuth for iCloud Calendar; CalDAV uses HTTP Basic auth. The connect form asks for
a server URL (default `https://caldav.icloud.com/`), a username (the Apple Account email), and a
password — for iCloud an **app-specific password** from account.apple.com, never the account
password. Discovery (`current-user-principal` → `calendar-home-set`, falling back to
`/.well-known/caldav`) is both the credential check and the source of the calendar home URL and the
account's own addresses (used to mark `self` attendees). Nothing is stored if it fails.

The password lives only in the `UserAccount` Durable Object and the gatekeeper DO's in-memory calls;
it never reaches agent-facing session objects. There is no refresh cycle: a 401 notifies the
Workshop once (`credentialsExpired`) and requires reconnecting. A reconnect must resolve to the same
calendar home, so existing bindings can't be silently repointed at a different account.

Redirects are followed by hand and only to `https:` URLs, so credentials are never sent in clear.
No deployment-wide secret is needed.

**A published calendar link (ICS).** A public feed — a holiday calendar, a team calendar, a sports
schedule — needs no credentials: the link itself is the capability, and anyone holding it can read
the feed. `webcal:` links are accepted and read over https. Fetching the feed is the check, so a
link that is not publicly readable (401/403) or does not return a calendar is refused at connect
time rather than stored. Subscriptions are read-only, and reconnecting must keep the same link.

The two kinds never mix: a connection offers either its calendars or its one subscribed calendar,
and binding the wrong resource kind is refused.

## Resources

| Resource | URL | Session |
| --- | --- | --- |
| One calendar | `https://caldav.local/calendar/<calendarId>` | `CalDavSession` |
| All calendars | `https://caldav.local/account` | `CalDavAccountSession` |
| Subscribed calendar | `https://caldav.local/subscription` | `CalDavSession` (read-only) |

CalDAV servers live on arbitrary hosts and the binding already belongs to one connected account,
so resource URLs use the fixed synthetic host `caldav.local` (as Home Assistant uses
`homeassistant.local`). `calendarId` is the calendar collection's last path segment. These URL
patterns are deployed identity — don't change them.

## Design notes

- **Events and ids.** A one-off event's `id`, and a repeating event's `seriesId`, is its CalDAV
  resource name. An occurrence's `id` is `<resource name>/<original start>` (`YYYYMMDD` or
  `YYYYMMDDTHHMMSSZ`). Ids are validated so they can only name a direct child of the bound calendar.
- **Recurrence** is expanded client-side (`src/recurrence.ts`) in wall-clock time, so a weekly
  09:00 event stays at 09:00 across DST. Supported: DAILY/WEEKLY/MONTHLY/YEARLY with INTERVAL,
  COUNT, UNTIL, BYDAY (with ordinals in months), BYMONTHDAY, BYMONTH, plus RDATE/EXDATE and
  RECURRENCE-ID overrides. Rules using anything else (BYSETPOS, BYWEEKNO, …) show only the first
  occurrence, and `repeats` says so.
- **Lossless edits.** `src/ical.ts` keeps every property it doesn't understand, so an update
  rewrites only the fields it touches. Occurrence edits add a RECURRENCE-ID override; occurrence
  deletes add an EXDATE. New events with a named time zone get a generated VTIMEZONE.
- **Invitations are read-only.** Any event with attendees can't be changed or deleted, because
  writing ATTENDEEs makes iCloud send real invitations and updates.
- **Approvals and simulation.** Every read calls `authorizeObservation()`; every write is journaled
  and submitted with `submitAction()`, and only reaches the server in `applyAction()`. Reads replay
  pending ops onto the server's current copy ("overlay at read time", `src/store.ts`), so an
  agent sees its own changes immediately and can update or delete an event it just created. Apply
  replays the same op on a freshly fetched copy with `If-Match` (or `If-None-Match: *` for creates),
  retrying once on a concurrent edit. A failed apply stays approvable. Approving an update to a
  not-yet-created event fails with a clear message until the create is approved.
- **Feeds.** A subscription is one GET of one iCalendar document, revalidated with ETag /
  Last-Modified after a 5-minute TTL and capped at 8 MB. The body is held in the gatekeeper DO's
  memory, not its storage, since feeds routinely exceed the 128 KiB value limit; a cold start
  refetches. `splitFeedObjects()` divides the feed into one object per UID so the same reader,
  recurrence expansion, and override handling serve feeds and CalDAV objects alike.
- **Observers.** Strategy A (private-only): CalDAV offers no per-observer access oracle, so
  bindings can't be shared.
- **Self-describing bindings.** The Workshop names a chat binding with a quick model that sees only
  `describe().title`, so a calendar's title is `Calendar: <name>` (and a whole-account binding's is
  `All calendars: <user>`). A bare name like "Personal" gets bound as something like
  `PERSONAL_INFO`, which tells the agent nothing about what the binding is.
- **Per-binding types.** Each binding's `getTypeScriptTypes()` returns only its own session's API,
  so a single-calendar binding is never shown the whole-account session it cannot reach; the vendor
  returns both. `src/type-bundle.ts` strips a declaration's module imports when flattening.
- **Clock.** Both sessions expose `getCurrentTime()`, returning today's date, the local time, the
  weekday, and the zone offset in the calendar's own time zone, so relative requests like "next
  week" don't depend on the agent guessing the date or the zone.

## Development

```sh
pnpm --filter gatekeeper-caldav test:run
pnpm --filter gatekeeper-caldav types:check
vp run -F gatekeeper-caldav --no-cache build   # configurator UIs + tsc
```

Tests use mocked `fetch` and need no credentials. They cover iCalendar parsing and round-trips,
time zones and VTIMEZONE generation, recurrence expansion, the event operations, CalDAV discovery
and requests, simulation and apply, resources, and the configurators. Nothing here has run against
a live iCloud account; the consuming starter's post-deploy verification checklist covers that.

## Current scope

- Events only: no reminders or tasks (VTODO), no creating/deleting calendars, no moving events
  between calendars, and no writing attendees.
- A subscribed calendar is read-only and exposes exactly one calendar; the whole-account session is
  not offered for it.
- `getBusyTime` covers only the connected account's own calendars; CalDAV scheduling free-busy for
  other people is not implemented.
- The calendar list is cached for 60 seconds.
