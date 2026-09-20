import { describe, expect, it, vi } from "vitest";

vi.mock("@gadgets/configurator-ui", () => ({
  h: (component: unknown, props: unknown, ...children: unknown[]) => ({ component, props, children }),
  Autocomplete: "Autocomplete",
  Field: "Field",
  Section: "Section",
}));
import { CalDavAccountConfiguratorUI } from "../src/caldav";
import { parseResourceUrl, toAccountResourceUrl, toCalendarResourceUrl } from "../src/resource";
import accountSpec from "../src/configurator/caldav-account-configurator-ui";
import calendarSpec from "../src/configurator/caldav-calendar-configurator-ui";

describe("account configurator", () => {
  it("is always ready and reports the whole-account URL", async () => {
    expect(accountSpec.isReady?.({ values: accountSpec.initial })).toBe(true);
    await expect(new CalDavAccountConfiguratorUI().resourceUrl()).resolves.toBe(toAccountResourceUrl());
  });
});

describe("calendar configurator", () => {
  const ui = { listCalendars: async () => [] };

  it("needs a calendar before it is ready", () => {
    expect(calendarSpec.isReady?.({ values: {} })).toBe(false);
    expect(calendarSpec.isReady?.({ values: { calendarId: "home" } })).toBe(true);
  });

  it("builds the same URL as the runtime resource module and parses it back", async () => {
    const url = await calendarSpec.resourceUrl({ values: { calendarId: "shared one" }, ui });
    expect(url).toBe(toCalendarResourceUrl("shared one"));
    expect(parseResourceUrl(url)).toEqual({ kind: "calendar", calendarId: "shared one" });
    expect(await calendarSpec.initialValuesFromResourceUrl?.({ resourceUrl: url, resourceUrlPattern: "", ui }))
      .toEqual({ calendarId: "shared one" });
  });
});
