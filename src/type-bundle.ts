/**
 * Assembles the agent-facing type bundles. Each binding gets only the types its own session needs
 * (a single-calendar binding never sees the whole-account API), the way upstream's Google
 * gatekeeper hands each of its resource types its own declaration; the vendor returns everything.
 *
 * The declarations are real modules so `tsc` checks them, but the agent sees one flat bundle, so a
 * declaration's `import` prefix is stripped when it is concatenated onto the types it imports.
 */

/** Module-only prefix of the whole-account declaration (`account-types.d.ts`). */
export const ACCOUNT_TYPES_MODULE_PREFIX =
  'import type {\n' +
  '  CalDavCalendarInfo,\n' +
  '  CalDavEvent,\n' +
  '  CalDavListEventsOptions,\n' +
  '  CalDavSession,\n' +
  '  CalDavTimeContext,\n' +
  '} from "./types";\n\n';

/** Removes a declaration's expected module prefix before adding it to the flat agent bundle. */
export function stripTypeModulePrefix(source: string, prefix: string): string {
  if (!source.startsWith(prefix)) {
    throw new Error("Agent type declaration has an unexpected module prefix.");
  }
  return source.slice(prefix.length);
}

/** The bundle for a whole-account binding: the calendar API plus the account API above it. */
export function accountTypeBundle(calendarTypes: string, accountTypes: string): string {
  return `${calendarTypes.trimEnd()}\n\n${stripTypeModulePrefix(accountTypes, ACCOUNT_TYPES_MODULE_PREFIX)}`;
}
