import { describe, expect, it } from "vitest";
// `?raw` reads the same files the Worker build loads as text modules (`.txt` module rules are a
// Wrangler build feature, not a Vite one).
import ACCOUNT_TYPES_CODE from "../src/account-types.txt?raw";
import TYPES_CODE from "../src/types.txt?raw";
import { ACCOUNT_TYPES_MODULE_PREFIX, accountTypeBundle, stripTypeModulePrefix } from "../src/type-bundle";

describe("agent type bundles", () => {
  it("gives a single-calendar binding only the calendar API", () => {
    expect(TYPES_CODE).toContain("export interface CalDavSession");
    expect(TYPES_CODE).toContain("getCurrentTime()");
    // The whole-account session is unreachable from a calendar binding, so it must not be shown.
    expect(TYPES_CODE).not.toContain("CalDavAccountSession");
  });

  it("gives a whole-account binding both APIs, with no module imports left in the flat bundle", () => {
    const bundle = accountTypeBundle(TYPES_CODE, ACCOUNT_TYPES_CODE);
    expect(bundle).toContain("export interface CalDavSession");
    expect(bundle).toContain("export interface CalDavAccountSession");
    expect(bundle).toContain("export type CalDavBusyBlock");
    expect(bundle).not.toContain("from \"./types\"");
  });

  it("fails loudly if a declaration's import prefix drifts", () => {
    expect(() => stripTypeModulePrefix("import type { Nope } from \"./types\";\n\n", ACCOUNT_TYPES_MODULE_PREFIX))
      .toThrow(/unexpected module prefix/);
  });
});
