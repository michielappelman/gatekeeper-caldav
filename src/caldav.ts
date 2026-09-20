import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import { createLogger } from "@gadgets/backend-utils/logger";
import {
  stripTrailingSlashes,
  type AccountDescription,
  type ApprovalQueue,
  type ConnectHandoff,
  type Gatekeeper,
  type GatekeeperConnectCallback,
  type GatekeeperUser,
  type GatekeeperUserVerifier,
  type GatekeeperVendor as GatekeeperVendorIface,
  type ResourceConfiguratorFrame,
  type ResourceDescription,
  type SupportedResource,
  type VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  connectHandoffPageHtml,
  errorPageHtml,
  escapeHtml,
  htmlResponse,
} from "@gadgets/gatekeeper-kit/connect-pages";
import { commitStagedCredentials, stageCredentials } from "@gadgets/gatekeeper-kit/credential-stage";
import {
  constantTimeEqual,
  CONNECT_TIMEOUT_MS,
  generateNonce,
  INITIATION_NONCE_LIFETIME_MS,
  isLiveNonce,
  NONCE_BYTES,
  type TimedNonce,
} from "@gadgets/gatekeeper-kit/connect-nonce";
import {
  discoverAccount,
  fetchIcsFeed,
  ICLOUD_CALDAV_URL,
  listCalendars,
  normalizeFeedUrl,
  normalizeServerUrl,
  type CalendarRecord,
} from "./caldav-api";
import { CalDavError } from "./errors";
import {
  applyOp,
  buildEventObject,
  describeTime,
  feedMetadata,
  MAX_WINDOW_MS,
  parseEventId,
  sortEvents,
  titleOf,
  type EventOp,
} from "./events";
import {
  CALDAV_ACCOUNT_RESOURCE,
  CALDAV_CALENDAR_RESOURCE,
  CALDAV_LOGO_URL,
  CALDAV_SUBSCRIPTION_RESOURCE,
  parseResourceUrl,
  SUPPORTED_RESOURCES,
  toAccountResourceUrl,
  toResourceUrl,
  toSubscriptionResourceUrl,
  type ResourceTarget,
} from "./resource";
import {
  CalendarStore,
  MAX_EVENTS,
  normalizeGrant,
  SUBSCRIPTION_CALENDAR_ID,
  SubscriptionStore,
  type FeedCache,
  type Grant,
  type SessionBackend,
} from "./store";
import { describeNow, zonedToUtc } from "./timezone";
import type { CalDavAccountSession, CalDavBusyBlock } from "./account-types";
import type {
  CalDavCalendarInfo,
  CalDavEvent,
  CalDavEventDraft,
  CalDavEventPatch,
  CalDavListEventsOptions,
  CalDavSession,
  CalDavTimeContext,
} from "./types";
import { accountTypeBundle } from "./type-bundle";
import TYPES_CODE from "./types.txt";
import ACCOUNT_TYPES_CODE from "./account-types.txt";
import type { CalDavAccountConfiguratorRpc } from "./configurator/caldav-account-configurator-types";
import type { CalDavSubscriptionConfiguratorRpc } from "./configurator/caldav-subscription-configurator-types";
import type {
  CalDavCalendarConfiguratorRpc,
  ConfiguratorOption,
} from "./configurator/caldav-calendar-configurator-types";
import CALDAV_ACCOUNT_CONFIGURATOR_HTML from "./generated/caldav-account-configurator-ui.txt";
import CALDAV_SUBSCRIPTION_CONFIGURATOR_HTML from "./generated/caldav-subscription-configurator-ui.txt";
import CALDAV_CALENDAR_CONFIGURATOR_HTML from "./generated/caldav-calendar-configurator-ui.txt";

type Env = Cloudflare.Env & {
  BASE_URL?: string;
};

const VENDOR_ID = "caldav";

type CalDavLogFields = {
  vendorId: string;
  actionId: number;
  kind: string;
  code: string;
  serverHost: string;
};

const logger = createLogger<CalDavLogFields>({ component: "gatekeeper.caldav", vendorId: VENDOR_ID });

function logFailure(event: string, error: unknown, fields: Partial<Omit<CalDavLogFields, "vendorId">> = {}): void {
  logger.error("calendar operation failed", {
    event, error, ...fields, code: error instanceof CalDavError ? error.code : undefined,
  });
}

function getBaseUrl(env: Env): string {
  return stripTrailingSlashes(env.BASE_URL ?? "http://localhost:8787/gatekeeper/caldav");
}

function getBasePath(env: Env): string {
  const path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

/** Which kind of connection the connect form is creating. */
type ConnectMode = "caldav" | "ics";

// ---------------------------------------------------------------------------
// Connect flow. CalDAV servers (iCloud included) authenticate with a username and password — for
// iCloud an app-specific password — so, as with gatekeeper-homeassistant's long-lived token, the
// human pastes a credential and the gatekeeper verifies it by discovering the calendar home.

export const CONNECT_FORM_HTML = (params: {
  actionUrl: string; error?: string; mode?: ConnectMode; serverUrl?: string; username?: string; feedUrl?: string;
}) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Connect a calendar</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; background: #f5f5f5; margin: 0; min-height: 100vh; display: flex; justify-content: center; align-items: center; }
  .card { background: white; padding: 2rem; max-width: 540px; width: 100%; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
  h1 { margin-top: 0; font-size: 1.4rem; color: #c62828; }
  label { display: block; font-weight: 600; margin-top: 1rem; margin-bottom: 0.25rem; color: #333; }
  input { width: 100%; box-sizing: border-box; padding: 0.5rem; font-size: 0.9rem; border: 1px solid #ccc; border-radius: 4px; }
  .hint { font-size: 0.85rem; color: #666; margin-top: 0.25rem; }
  details { margin-top: 1rem; font-size: 0.9rem; color: #555; }
  summary { cursor: pointer; color: #c62828; }
  details ol { padding-left: 1.25rem; }
  button { margin-top: 1.5rem; padding: 0.6rem 1.5rem; background: #c62828; color: white; border: none; border-radius: 4px; font-size: 1rem; cursor: pointer; }
  button:hover { background: #a61f1f; }
  .error { background: #ffebee; color: #c62828; padding: 0.75rem 1rem; border-radius: 4px; margin: 1rem 0; }
  fieldset { border: 1px solid #ddd; border-radius: 6px; margin: 1.25rem 0 0; padding: 0 1rem 1rem; transition: opacity 0.15s; }
  fieldset[data-inactive] { opacity: 0.5; }
  legend { font-weight: 600; padding: 0 0.4rem; }
  legend input { width: auto; margin-right: 0.4rem; }
</style>
</head>
<body>
  <div class="card">
    <h1>Connect a calendar</h1>
    <p>Connect iCloud Calendar or any other CalDAV server so Cloudflare OS can read and manage your
    events, or subscribe to a published calendar link to read someone else's public calendar.</p>
    ${params.error ? `<div class="error">${escapeHtml(params.error)}</div>` : ""}
    <form method="POST" action="${escapeHtml(params.actionUrl)}">
      <fieldset data-mode="caldav">
        <legend><label><input type="radio" name="mode" value="caldav"${params.mode === "ics" ? "" : " checked"}>Calendar account</label></legend>
      <label for="serverUrl">CalDAV server</label>
      <input id="serverUrl" name="serverUrl" type="text" value="${escapeHtml(params.serverUrl ?? ICLOUD_CALDAV_URL)}">
      <div class="hint">Leave as is for iCloud.</div>

      <label for="username">Username</label>
      <input id="username" name="username" type="text" autocomplete="username" value="${escapeHtml(params.username ?? "")}" placeholder="you@icloud.com"${params.mode === "ics" ? "" : " autofocus"}>
      <div class="hint">For iCloud, your Apple Account email address.</div>

      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="off">
      <div class="hint">For iCloud, an app-specific password — never your Apple Account password.</div>

      <details open>
        <summary>How to create an iCloud app-specific password</summary>
        <ol>
          <li>Sign in at <a href="https://account.apple.com" target="_blank" rel="noopener">account.apple.com</a>.</li>
          <li>Open <strong>Sign-In and Security &rarr; App-Specific Passwords</strong> and create one (e.g. "Cloudflare OS").</li>
          <li>Paste it above. You can revoke it there at any time.</li>
        </ol>
      </details>
      </fieldset>

      <fieldset data-mode="ics">
        <legend><label><input type="radio" name="mode" value="ics"${params.mode === "ics" ? " checked" : ""}>Published calendar link</label></legend>
        <label for="feedUrl">Calendar link (.ics or webcal)</label>
        <input id="feedUrl" name="feedUrl" type="text" value="${escapeHtml(params.feedUrl ?? "")}" placeholder="https://example.com/holidays.ics"${params.mode === "ics" ? " autofocus" : ""}>
        <div class="hint">A public, read-only calendar feed &mdash; a team calendar, a holiday
        calendar, a sports schedule. No password is needed, and events on it cannot be changed.</div>
      </fieldset>

      <button type="submit">Connect</button>
    </form>
  </div>
<script>
  var sets = document.querySelectorAll("fieldset[data-mode]");
  function sync() {
    var chosen = document.querySelector('input[name="mode"]:checked');
    sets.forEach(function (set) {
      set.toggleAttribute("data-inactive", !chosen || set.dataset.mode !== chosen.value);
    });
  }
  document.querySelectorAll('input[name="mode"]').forEach(function (radio) {
    radio.addEventListener("change", sync);
  });
  // Typing in a field picks the kind of connection it belongs to.
  sets.forEach(function (set) {
    set.querySelectorAll('input:not([name="mode"])').forEach(function (field) {
      field.addEventListener("focus", function () {
        var radio = set.querySelector('input[name="mode"]');
        if (!radio.checked) {
          radio.checked = true;
          sync();
        }
      });
    });
  });
  sync();
</script>
</body>
</html>`;

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const basePath = getBasePath(env);
    if (!url.pathname.startsWith(`${basePath}/`) && url.pathname !== basePath) {
      throw new Error(`Request path ${url.pathname} does not match BASE_URL path ${basePath}`);
    }
    const path = url.pathname.slice(basePath.length).slice(1).split("/");

    // Connect URL: /<doId>/<nonce>
    if (path.length === 2 && path[0].length === 64 && path[1].length === NONCE_BYTES * 2) {
      const [doId, nonce] = path;
      let stub: DurableObjectStub<UserAccount>;
      try {
        stub = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(doId));
      } catch {
        return new Response("Not Found", { status: 404 });
      }

      if (req.method === "GET") {
        const valid = await stub.verifyNonceWithoutConsuming(nonce);
        if (!valid) return htmlResponse(errorPageHtml("Link expired", "Start the connection again."));
        return htmlResponse(CONNECT_FORM_HTML({ actionUrl: req.url }));
      }

      if (req.method === "POST") {
        let formData: FormData;
        try {
          formData = await req.formData();
        } catch {
          return new Response("Invalid form submission.", { status: 400 });
        }
        const mode: ConnectMode = formData.get("mode") === "ics" ? "ics" : "caldav";
        const serverUrl = String(formData.get("serverUrl") ?? "").trim();
        const username = String(formData.get("username") ?? "").trim();
        const password = String(formData.get("password") ?? "");
        const feedUrl = String(formData.get("feedUrl") ?? "").trim();
        const form = { actionUrl: req.url, mode, serverUrl, username, feedUrl };
        if (mode === "ics" && !feedUrl) {
          return htmlResponse(CONNECT_FORM_HTML({ ...form, error: "Enter the published calendar link." }), 400);
        }
        if (mode === "caldav" && (!serverUrl || !username || !password)) {
          return htmlResponse(CONNECT_FORM_HTML({ ...form, error: "Server, username, and password are all required." }), 400);
        }

        const result = await stub.completeConnection(nonce, mode === "ics"
          ? { mode: "ics", feedUrl }
          : { mode: "caldav", serverUrl, username, password });
        if (result.kind === "invalid_nonce") {
          return htmlResponse(errorPageHtml("Link expired", "Start the connection again."));
        }
        if (result.kind === "error") {
          return htmlResponse(CONNECT_FORM_HTML({ ...form, error: result.message }), 400);
        }
        return htmlResponse(connectHandoffPageHtml(result.handoff));
      }
    }

    return new Response("Not Found", { status: 404 });
  },
};

// ---------------------------------------------------------------------------
// Vendor

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Calendar (CalDAV)",
      url: "https://www.icloud.com/calendar",
      logo: { url: CALDAV_LOGO_URL },
      color: "#fdecea",
      tagline: "Read and manage events in iCloud Calendar or any CalDAV calendar",
      description:
          "Connect iCloud Calendar (with an app-specific password) or another CalDAV server so " +
          "Cloudflare OS can read your events and busy time, and create, change, or delete events " +
          "with your approval. Choose one calendar or all of them per connection.",
      providesAuth: false,
    };
  }

  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>): Promise<{ url: string }> {
    const userObjectId = this.ctx.exports.UserAccount.newUniqueId();
    const nonce = generateNonce();
    await this.ctx.exports.UserAccount.get(userObjectId).setCallback(callback, nonce);
    return { url: `${getBaseUrl(this.env)}/${userObjectId.toString()}/${nonce}` };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getTypeScriptTypes(): Promise<string> {
    return accountTypeBundle(TYPES_CODE, ACCOUNT_TYPES_CODE);
  }
}

// ---------------------------------------------------------------------------
// UserAccount DO — holds the CalDAV credentials and the calendar home discovered with them. Like an
// API token there is no refresh cycle: the password stays valid until the user revokes it.

type StoredNonce = TimedNonce & {
  reconnect?: true;
  /** Set while a submission is being validated, so a concurrent submission cannot reuse the nonce;
   * cleared when validation fails so the user can resubmit. */
  connecting?: true;
};

/** How a connected account presents itself, whichever kind it is. */
type AccountIdentity = {
  kind: "caldav" | "ics";
  /** The account's username, or the subscribed calendar's name. */
  username: string;
  serverHost: string;
  displayName?: string;
};

type CompleteConnectionResult =
  | { kind: "ok"; handoff: ConnectHandoff }
  | { kind: "invalid_nonce" }
  | { kind: "error"; message: string };

function connectErrorMessage(error: unknown): string {
  if (error instanceof CalDavError) {
    switch (error.code) {
      case "AUTH_EXPIRED":
        return "The server rejected that username or password. For iCloud, use an app-specific password.";
      case "INVALID_ARGUMENT":
      case "RESOURCE_NOT_FOUND":
        return error.message;
      default:
        return `Could not connect to the calendar server: ${error.message}`;
    }
  }
  return "Could not connect to the calendar server.";
}

export class UserAccount extends DurableObject<Env> {
  async setCallback(callback: Fetcher<GatekeeperConnectCallback>, nonce: string): Promise<void> {
    if (!this.ctx.storage.kv.get<Grant>("grant")) {
      await this.ctx.storage.setAlarm(Date.now() + CONNECT_TIMEOUT_MS);
    }
    this.ctx.storage.kv.put("callback", callback);
    this.ctx.storage.kv.put<StoredNonce>("nonce", { value: nonce, expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS });
  }

  async prepareReconnect(nonce: string): Promise<void> {
    this.ctx.storage.kv.put("expiredNotified", false);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: nonce, expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS, reconnect: true,
    });
  }

  async verifyNonceWithoutConsuming(nonce: string): Promise<boolean> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    return !stored?.connecting && isLiveNonce(stored, nonce, Date.now());
  }

  #releaseNonceClaim(nonce: string): void {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (stored && constantTimeEqual(stored.value, nonce)) {
      this.ctx.storage.kv.put<StoredNonce>("nonce", { ...stored, connecting: undefined });
    }
  }

  async completeConnection(
    nonce: string,
    input:
      | { mode: "caldav"; serverUrl: string; username: string; password: string }
      | { mode: "ics"; feedUrl: string },
  ): Promise<CompleteConnectionResult> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.connecting || !isLiveNonce(stored, nonce, Date.now())) {
      return { kind: "invalid_nonce" };
    }
    // Claim the nonce before the first await: the input gate does not cover outbound fetches.
    this.ctx.storage.kv.put<StoredNonce>("nonce", { ...stored, connecting: true });

    let grant: Grant;
    try {
      const existing = this.#storedGrant();
      if (stored.reconnect && existing && existing.kind !== input.mode) {
        throw new CalDavError("INVALID_ARGUMENT", existing.kind === "ics"
          ? "This connection is a subscribed calendar link. Reconnect it with a calendar link, or add a new connection."
          : "This connection is a calendar account. Reconnect it with that account, or add a new connection.");
      }
      if (input.mode === "ics") {
        const url = normalizeFeedUrl(input.feedUrl);
        if (stored.reconnect && existing?.kind === "ics" && existing.url !== url) {
          throw new CalDavError("INVALID_ARGUMENT",
            "That is a different calendar link. Reconnect with the original link, or add a new connection instead.");
        }
        // Fetching it is the check: a link that cannot be read publicly is not a connection.
        const feed = await fetchIcsFeed(url);
        const text = feed.status === "ok" ? feed.text : "";
        grant = { kind: "ics", url, name: feedMetadata(text).name || new URL(url).hostname };
      } else {
        const serverUrl = normalizeServerUrl(input.serverUrl);
        const credentials = { username: input.username, password: input.password };
        const info = await discoverAccount(serverUrl, credentials);
        if (stored.reconnect && existing?.kind === "caldav" && existing.homeUrl !== info.homeUrl) {
          // Bindings made under this connection name calendars of the original account; silently
          // repointing them at another account's calendars would be surprising at best.
          throw new CalDavError("INVALID_ARGUMENT",
            "Those credentials belong to a different calendar account. Reconnect with the original account, " +
            "or add a new connection instead.");
        }
        grant = { kind: "caldav", serverUrl, ...credentials, ...info };
      }
    } catch (error) {
      this.#releaseNonceClaim(nonce);
      logFailure("connect.failed", error, {
        serverHost: safeHost(input.mode === "ics" ? input.feedUrl : input.serverUrl),
      });
      return { kind: "error", message: connectErrorMessage(error) };
    }

    this.ctx.storage.kv.delete("nonce");
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) {
      return { kind: "error", message: "Took too long to complete authorization. Please try again." };
    }

    let handoff: ConnectHandoff;
    if (stored.reconnect) {
      // The reconnect URL is a bearer capability, so the new grant is only staged until the Workshop
      // confirms the browser that finished the flow is the owner's.
      const stageId = stageCredentials(this.ctx.storage.kv, grant, Date.now());
      handoff = await callback.reconnectComplete(stageId);
    } else {
      this.#writeGrant(grant);
      try {
        const props: CalDavUserImplProps = { userObjectId: this.ctx.id.toString() };
        handoff = await callback.complete(this.ctx.exports.CalDavGatekeeperUserImpl({ props }));
      } catch (err) {
        this.ctx.storage.kv.delete("grant");
        throw err;
      }
    }
    await this.ctx.storage.deleteAlarm();
    return { kind: "ok", handoff };
  }

  async commitReconnect(stageId: string): Promise<void> {
    const grant = commitStagedCredentials<Grant>(this.ctx.storage.kv, Date.now(), stageId);
    if (!grant) throw new Error("No reconnect is awaiting confirmation. Please try again.");
    this.#writeGrant(grant);
  }

  #writeGrant(grant: Grant): void {
    this.ctx.storage.kv.put("grant", grant);
    this.ctx.storage.kv.put("expiredNotified", false);
  }

  /** The stored grant, normalized (grants written before subscriptions existed carry no `kind`). */
  #storedGrant(): Grant | undefined {
    const stored = this.ctx.storage.kv.get<Grant>("grant");
    return stored ? normalizeGrant(stored) : undefined;
  }

  async getIdentity(): Promise<AccountIdentity | undefined> {
    const grant = this.#storedGrant();
    if (!grant) return undefined;
    if (grant.kind === "ics") {
      return { kind: "ics", username: grant.name, serverHost: new URL(grant.url).hostname };
    }
    return {
      kind: "caldav", username: grant.username, serverHost: new URL(grant.serverUrl).hostname,
      displayName: grant.displayName,
    };
  }

  async getGrant(): Promise<Grant> {
    const grant = this.#storedGrant();
    if (!grant) throw new CalDavError("AUTH_REQUIRED", "The calendar account is not connected.");
    return grant;
  }

  /** Called when the server answers 401: the password was revoked or changed. */
  async noteCredentialsExpired(): Promise<void> {
    if (this.ctx.storage.kv.get<boolean>("expiredNotified")) return;
    this.ctx.storage.kv.put("expiredNotified", true);
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (callback) await callback.credentialsExpired();
  }

  /** For the calendar picker. */
  async listCalendars(): Promise<CalendarRecord[]> {
    const grant = await this.getGrant();
    if (grant.kind === "ics") {
      return [{ id: SUBSCRIPTION_CALENDAR_ID, url: grant.url, name: grant.name, readOnly: true }];
    }
    try {
      return await listCalendars(grant.homeUrl, grant);
    } catch (error) {
      if (error instanceof CalDavError && error.code === "AUTH_EXPIRED") await this.noteCredentialsExpired();
      throw error;
    }
  }

  async alarm(): Promise<void> {
    if (!this.ctx.storage.kv.get<Grant>("grant")) await this.ctx.storage.deleteAll();
  }

  async revoke(): Promise<void> {
    // CalDAV has no revocation endpoint; dropping the stored password stops all further use. The
    // user can also revoke the app-specific password in their Apple Account settings.
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

function safeHost(serverUrl: string): string | undefined {
  try {
    return new URL(normalizeServerUrl(serverUrl)).hostname;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// GatekeeperUser

type CalDavUserImplProps = { userObjectId: string };

@validateRpc()
export class CalDavGatekeeperUserImpl extends WorkerEntrypoint<Env, CalDavUserImplProps> implements GatekeeperUser {
  #userAccount(): DurableObjectStub<UserAccount> {
    return this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  async describe(): Promise<AccountDescription> {
    const identity = await this.#userAccount().getIdentity();
    if (identity?.kind === "ics") {
      return {
        displayName: `${identity.username} (subscribed calendar)`,
        uniqueName: `ics:${identity.username}@${identity.serverHost}`,
        avatar: { url: CALDAV_LOGO_URL },
      };
    }
    return {
      displayName: identity ? `${identity.username} (${identity.serverHost})` : "Calendar account",
      uniqueName: identity ? `${identity.username}@${identity.serverHost}` : undefined,
      avatar: { url: CALDAV_LOGO_URL },
    };
  }

  /** A subscription offers only itself; an account offers its calendars and the whole-account view. */
  async getSupportedResources(): Promise<SupportedResource[]> {
    const identity = await this.#userAccount().getIdentity();
    if (identity?.kind === "ics") return [CALDAV_SUBSCRIPTION_RESOURCE];
    return [CALDAV_CALENDAR_RESOURCE, CALDAV_ACCOUNT_RESOURCE];
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
  }> {
    const target = parseResourceUrl(url);
    // The connection kind decides which resources exist: a CalDAV account has no feed behind it,
    // and a subscription has no account to enumerate.
    const identity = await this.#userAccount().getIdentity();
    const isSubscription = identity?.kind === "ics";
    if (isSubscription !== (target.kind === "subscription")) {
      throw new CalDavError("INVALID_RESOURCE", isSubscription
        ? "This connection is a subscribed calendar link; bind the subscribed calendar instead."
        : "This connection is a calendar account; bind one of its calendars instead.");
    }
    const props: CalDavGatekeeperImplProps = { userObjectId: this.ctx.props.userObjectId, target };
    return {
      class: this.ctx.exports.CalDavGatekeeperImpl({ props }),
      resource: target.kind === "account" ? CALDAV_ACCOUNT_RESOURCE
        : target.kind === "subscription" ? CALDAV_SUBSCRIPTION_RESOURCE : CALDAV_CALENDAR_RESOURCE,
    };
  }

  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    if (resourceUrlPattern === CALDAV_CALENDAR_RESOURCE.urlPattern) {
      return {
        iframeHtml: CALDAV_CALENDAR_CONFIGURATOR_HTML,
        ui: new RpcStub(new CalDavCalendarConfiguratorUI(this.#userAccount())),
      };
    }
    if (resourceUrlPattern === CALDAV_ACCOUNT_RESOURCE.urlPattern) {
      return { iframeHtml: CALDAV_ACCOUNT_CONFIGURATOR_HTML, ui: new RpcStub(new CalDavAccountConfiguratorUI()) };
    }
    if (resourceUrlPattern === CALDAV_SUBSCRIPTION_RESOURCE.urlPattern) {
      return {
        iframeHtml: CALDAV_SUBSCRIPTION_CONFIGURATOR_HTML,
        ui: new RpcStub(new CalDavSubscriptionConfiguratorUI()),
      };
    }
    throw new Error(`Unsupported CalDAV resource configurator type: ${resourceUrlPattern}`);
  }

  async revoke(): Promise<void> {
    await this.#userAccount().revoke();
  }

  async reconnect(): Promise<{ url: string }> {
    const nonce = generateNonce();
    await this.#userAccount().prepareReconnect(nonce);
    return { url: `${getBaseUrl(this.env)}/${this.ctx.props.userObjectId}/${nonce}` };
  }

  async commitReconnect(stageId: string): Promise<void> {
    await this.#userAccount().commitReconnect(stageId);
  }

  /** CalDAV is not offered as a sign-in identity provider. */
  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  /** The password already grants everything the account can do; there is nothing to expand. */
  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  /** Strategy A (see CalDavGatekeeperImpl.addObserver): never consulted, but must resolve. */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.CalDavVerifier({});
  }
}

@validateRpc()
export class CalDavVerifier extends WorkerEntrypoint<Env> implements GatekeeperUserVerifier {
  verify(): void {}
}

// ---------------------------------------------------------------------------
// Resource configurators

@validateRpc()
export class CalDavCalendarConfiguratorUI extends RpcTarget implements CalDavCalendarConfiguratorRpc {
  #account: DurableObjectStub<UserAccount>;

  constructor(account: DurableObjectStub<UserAccount>) {
    super();
    this.#account = account;
  }

  async listCalendars(query: string): Promise<ConfiguratorOption[]> {
    const needle = query.trim().toLowerCase();
    const calendars = await this.#account.listCalendars();
    return calendars
      .filter(calendar => !needle || calendar.name.toLowerCase().includes(needle))
      .map(calendar => ({
        value: calendar.id,
        title: calendar.name,
        subtitle: calendar.readOnly ? "Read-only" : undefined,
      }));
  }
}

@validateRpc()
export class CalDavAccountConfiguratorUI extends RpcTarget implements CalDavAccountConfiguratorRpc {
  async resourceUrl(): Promise<string> {
    return toAccountResourceUrl();
  }
}

@validateRpc()
export class CalDavSubscriptionConfiguratorUI extends RpcTarget implements CalDavSubscriptionConfiguratorRpc {
  async resourceUrl(): Promise<string> {
    return toSubscriptionResourceUrl();
  }
}

// ---------------------------------------------------------------------------
// Gatekeeper DO — one binding: either one calendar or the whole account.

type CalDavGatekeeperImplProps = { userObjectId: string; target: ResourceTarget };

type ActionKindTag = "create" | "update" | "delete";

@validateRpc()
export class CalDavGatekeeperImpl extends DurableObject<Env, CalDavGatekeeperImplProps>
    implements Gatekeeper<CalDavSession | CalDavAccountSession> {
  #userAccount(): DurableObjectStub<UserAccount> {
    return this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  #store(): CalendarStore {
    return new CalendarStore(this.#userAccount(), this.ctx.storage.kv, (event, error) => logFailure(event, error));
  }

  /** The fetched feed of a subscription binding. Feeds are too large for Durable Object storage,
   * so this lives only as long as the instance; a cold start just fetches again. */
  #feedCache: FeedCache = {};

  /** Whichever backend this binding's sessions read through. */
  #backend(): SessionBackend {
    return this.ctx.props.target.kind === "subscription"
      ? new SubscriptionStore(this.#userAccount(), this.#feedCache)
      : this.#store();
  }

  async describe(): Promise<ResourceDescription> {
    const target = this.ctx.props.target;
    const identity = await this.#userAccount().getIdentity();
    const account = identity ? `${identity.username} (${identity.serverHost})` : "the connected account";
    if (target.kind === "account") {
      return {
        url: toResourceUrl(target),
        title: identity ? `All calendars: ${identity.username}` : "All calendars",
        snippet: `Read events and busy time across every calendar of ${account}, and manage events on them.`,
        suggestedBindingName: "CALENDARS",
        tsType: "CalDavAccountSession",
      };
    }
    if (target.kind === "subscription") {
      let name = identity?.username ?? "Subscribed calendar";
      try {
        name = (await this.#backend().calendar(SUBSCRIPTION_CALENDAR_ID)).name;
      } catch (error) {
        logFailure("describe.lookupFailed", error);
      }
      return {
        url: toResourceUrl(target),
        title: `Calendar: ${name}`,
        snippet: `Read events and busy time from the subscribed calendar "${name}". Read-only.`,
        suggestedBindingName: "CALENDAR",
        tsType: "CalDavSession",
      };
    }
    let name = target.calendarId;
    try {
      name = (await this.#store().calendar(target.calendarId)).name;
    } catch (error) {
      logFailure("describe.lookupFailed", error);
    }
    return {
      url: toResourceUrl(target),
      // The chat binding name is generated from this title alone, so it must name the resource
      // *and* say what it is; "Personal" on its own gets bound as something like PERSONAL_INFO.
      title: `Calendar: ${name}`,
      snippet: `Read and manage events on the "${name}" calendar of ${account}.`,
      suggestedBindingName: "CALENDAR",
      tsType: "CalDavSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return this.ctx.props.target.kind === "account"
      ? accountTypeBundle(TYPES_CODE, ACCOUNT_TYPES_CODE)
      : TYPES_CODE;
  }

  async getAutoApprovableActions() {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<CalDavSession | CalDavAccountSession> {
    const target = this.ctx.props.target;
    if (target.kind === "account") return new CalDavAccountSessionImpl(approvalQueue.dup(), this.#store());
    return new CalDavSessionImpl(
      approvalQueue.dup(), this.#backend(),
      target.kind === "subscription" ? SUBSCRIPTION_CALENDAR_ID : target.calendarId);
  }

  /** Action ids being applied in this instance, so a concurrent second approval can't apply twice. */
  #applying = new Set<number>();

  async applyAction(actionId: number): Promise<void> {
    if (this.#applying.has(actionId)) throw new Error(`Calendar action ${actionId} is already being applied.`);
    this.#applying.add(actionId);
    try {
      await this.#store().apply(actionId);
    } catch (error) {
      logFailure("apply.failed", error, { actionId });
      throw error;
    } finally {
      this.#applying.delete(actionId);
    }
  }

  async rejectAction(actionId: number): Promise<void> {
    this.#store().reject(actionId);
  }

  async revertAction(_actionId: number): Promise<{ message: string; canRetry: boolean }> {
    return {
      message: "Calendar changes can't be reverted automatically. Undo the change in your calendar app.",
      canRetry: false,
    };
  }

  /**
   * Observer tracking — strategy A (private-only). Calendars are personal, and CalDAV offers no way
   * to check whether a different connected account can see the same calendar (collection URLs are
   * per-account even for shared calendars), so no collaborator may observe this binding's reads.
   */
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    throw new Error("This calendar cannot be shared with other users: only the person who connected it may observe it.");
  }

  async removeObserver(_id: string): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Sessions

function toWindow(opts: { start: Date; end: Date }): { startMs: number; endMs: number } {
  const startMs = opts.start instanceof Date ? opts.start.getTime() : Number.NaN;
  const endMs = opts.end instanceof Date ? opts.end.getTime() : Number.NaN;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    throw new CalDavError("INVALID_ARGUMENT", "start and end must be valid Dates.");
  }
  if (endMs <= startMs) throw new CalDavError("INVALID_ARGUMENT", "end must be after start.");
  if (endMs - startMs > MAX_WINDOW_MS) {
    throw new CalDavError("INVALID_ARGUMENT", "The window may span at most 366 days.");
  }
  return { startMs, endMs };
}

function describeWindow(window: { startMs: number; endMs: number }): string {
  return `${new Date(window.startMs).toISOString().slice(0, 10)} to ${new Date(window.endMs).toISOString().slice(0, 10)}`;
}

function toInfo(calendar: CalendarRecord): CalDavCalendarInfo {
  return {
    id: calendar.id,
    name: calendar.name,
    color: calendar.color,
    description: calendar.description,
    timeZone: calendar.timeZone,
    readOnly: calendar.readOnly,
  };
}

function assertWritable(calendar: CalendarRecord): void {
  if (calendar.readOnly) {
    throw new CalDavError("READ_ONLY", `The "${calendar.name}" calendar is read-only.`);
  }
}

@validateRpc()
export class CalDavSessionImpl extends RpcTarget implements CalDavSession {
  #approvalQueue: RpcStub<ApprovalQueue>;
  #store: SessionBackend;
  #calendarId: string;

  constructor(approvalQueue: RpcStub<ApprovalQueue>, store: SessionBackend, calendarId: string) {
    super();
    this.#approvalQueue = approvalQueue;
    this.#store = store;
    this.#calendarId = calendarId;
  }

  [Symbol.dispose]() {
    this.#approvalQueue[Symbol.dispose]();
  }

  async getCurrentTime(): Promise<CalDavTimeContext> {
    const calendar = await this.#store.calendar(this.#calendarId);
    return describeNow(Date.now(), calendar.timeZone ?? "UTC");
  }

  async getCalendar(): Promise<CalDavCalendarInfo> {
    const calendar = await this.#store.calendar(this.#calendarId);
    await this.#approvalQueue.authorizeObservation({
      title: "Read calendar details",
      description: `Read the details of the "${calendar.name}" calendar.`,
    });
    return toInfo(calendar);
  }

  async listEvents(opts: CalDavListEventsOptions): Promise<CalDavEvent[]> {
    const window = toWindow(opts);
    const calendar = await this.#store.calendar(this.#calendarId);
    const events = await this.#store.listEvents(calendar, window, opts.includeDescriptions ?? false);
    await this.#approvalQueue.authorizeObservation({
      title: "List calendar events",
      description: `Read ${events.length} event(s) on "${calendar.name}" from ${describeWindow(window)}.`,
    });
    return events;
  }

  async #submit(calendar: CalendarRecord, objectName: string, op: EventOp, kind: ActionKindTag, title: string, description: string): Promise<void> {
    const actionId = this.#store.recordPending(calendar, objectName, op);
    // Not cleaned up on a thrown error: the overseer commits the action durably before
    // submitAction() returns, so a lost response can still mean a live, approvable action whose
    // journal entry applyAction() will need.
    await this.#approvalQueue.submitAction(actionId, {
      title,
      description,
      implementsRevert: false,
      actionKind: { tag: `event.${kind}`, label: `${kind[0].toUpperCase()}${kind.slice(1)} calendar events` },
    });
  }

  async createEvent(event: CalDavEventDraft): Promise<{ id: string }> {
    const calendar = await this.#store.calendar(this.#calendarId);
    assertWritable(calendar);
    const uid = crypto.randomUUID();
    const objectName = `${uid}.ics`;
    const ics = buildEventObject(event, uid, await this.#store.context(calendar), Date.now());
    await this.#submit(calendar, objectName, { kind: "create", objectName, ics }, "create",
      "Create calendar event",
      `Create "${event.title}" on "${calendar.name}" starting ${describeTime(event.start)}` +
      `${event.recurrence ? `, repeating ${event.recurrence.frequency}` : ""}.`);
    return { id: objectName };
  }

  async updateEvent(id: string, patch: CalDavEventPatch): Promise<void> {
    const target = parseEventId(id);
    const calendar = await this.#store.calendar(this.#calendarId);
    assertWritable(calendar);
    const context = await this.#store.context(calendar);
    const current = await this.#store.currentText(calendar, target.objectName);
    const op: EventOp = { kind: "update", target, patch, now: Date.now() };
    applyOp(current, op, context); // validates: throws if the change can't apply
    const title = titleOf(current, target, context) ?? "an event";
    const changed = Object.keys(patch).filter(key => patch[key as keyof CalDavEventPatch] !== undefined);
    await this.#submit(calendar, target.objectName, op, "update", "Change calendar event",
      `Change ${changed.join(", ") || "nothing"} of "${title}"` +
      `${target.occurrence ? " (this occurrence only)" : ""} on "${calendar.name}"` +
      `${patch.start ? `, now starting ${describeTime(patch.start)}` : ""}.`);
  }

  async deleteEvent(id: string): Promise<void> {
    const target = parseEventId(id);
    const calendar = await this.#store.calendar(this.#calendarId);
    assertWritable(calendar);
    const context = await this.#store.context(calendar);
    const current = await this.#store.currentText(calendar, target.objectName);
    const op: EventOp = { kind: "delete", target, now: Date.now() };
    applyOp(current, op, context);
    const title = titleOf(current, target, context) ?? "an event";
    await this.#submit(calendar, target.objectName, op, "delete", "Delete calendar event",
      `Delete "${title}"${target.occurrence ? ` (only the occurrence on ${target.occurrence.slice(0, 8)})` : ""} ` +
      `from "${calendar.name}".`);
  }
}

@validateRpc()
export class CalDavAccountSessionImpl extends RpcTarget implements CalDavAccountSession {
  #approvalQueue: RpcStub<ApprovalQueue>;
  #store: CalendarStore;

  constructor(approvalQueue: RpcStub<ApprovalQueue>, store: CalendarStore) {
    super();
    this.#approvalQueue = approvalQueue;
    this.#store = store;
  }

  [Symbol.dispose]() {
    this.#approvalQueue[Symbol.dispose]();
  }

  async getCurrentTime(): Promise<CalDavTimeContext> {
    const zones = (await this.#store.calendars()).flatMap(calendar => calendar.timeZone ?? []);
    const counts = new Map<string, number>();
    for (const zone of zones) counts.set(zone, (counts.get(zone) ?? 0) + 1);
    const commonest = [...counts].toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    return describeNow(Date.now(), commonest?.[0] ?? "UTC");
  }

  async listCalendars(): Promise<CalDavCalendarInfo[]> {
    const calendars = await this.#store.calendars();
    await this.#approvalQueue.authorizeObservation({
      title: "List calendars",
      description: `Listed ${calendars.length} calendar(s).`,
    });
    return calendars.map(toInfo);
  }

  async getCalendar(calendarId: string): Promise<CalDavSession> {
    await this.#store.calendar(calendarId); // throws for an unknown id
    return new CalDavSessionImpl(this.#approvalQueue.dup(), this.#store, calendarId);
  }

  async #allEvents(window: { startMs: number; endMs: number }, includeDescriptions: boolean): Promise<CalDavEvent[]> {
    const calendars = await this.#store.calendars();
    const perCalendar = await Promise.all(calendars.map(calendar =>
      this.#store.listEvents(calendar, window, includeDescriptions)));
    const events = perCalendar.flat();
    if (events.length > MAX_EVENTS) {
      throw new CalDavError("TOO_MANY_EVENTS", "Too many events in this window; narrow it and retry.");
    }
    return sortEvents(events);
  }

  async listEvents(opts: CalDavListEventsOptions): Promise<CalDavEvent[]> {
    const window = toWindow(opts);
    const events = await this.#allEvents(window, opts.includeDescriptions ?? false);
    await this.#approvalQueue.authorizeObservation({
      title: "List calendar events",
      description: `Read ${events.length} event(s) across all calendars from ${describeWindow(window)}.`,
    });
    return events;
  }

  async getBusyTime(opts: { start: Date; end: Date }): Promise<CalDavBusyBlock[]> {
    const window = toWindow(opts);
    const events = await this.#allEvents(window, false);
    const calendars = new Map((await this.#store.calendars()).map(calendar => [calendar.id, calendar]));
    const intervals: { start: number; end: number }[] = [];
    for (const event of events) {
      if (!event.busy || event.status === "cancelled") continue;
      const tz = calendars.get(event.calendarId)?.timeZone ?? "UTC";
      const bounds = [event.start, event.end].map(time => time.kind === "dateTime"
        ? time.dateTime.getTime()
        : zonedMidnight(time.date, tz));
      intervals.push({
        start: Math.max(bounds[0], window.startMs),
        end: Math.min(Math.max(bounds[1], bounds[0]), window.endMs),
      });
    }
    intervals.sort((a, b) => a.start - b.start);
    const merged: { start: number; end: number }[] = [];
    for (const interval of intervals) {
      const last = merged[merged.length - 1];
      if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
      else merged.push({ ...interval });
    }
    await this.#approvalQueue.authorizeObservation({
      title: "Read busy time",
      description: `Read busy time (no event details) across all calendars from ${describeWindow(window)}.`,
    });
    return merged.filter(block => block.end > block.start)
      .map(block => ({ start: new Date(block.start), end: new Date(block.end) }));
  }
}

function zonedMidnight(date: string, timeZone: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return zonedToUtc({ year, month, day, hour: 0, minute: 0, second: 0 }, timeZone);
}

