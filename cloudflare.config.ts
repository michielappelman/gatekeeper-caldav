import {
  CAPNWEB_VALIDATE_BUILD, OBSERVABILITY, defineGadgetsWorker, type DurableObjectMigration,
  type WranglerExtras,
} from "@gadgets/scripts/worker-config";

export default defineGadgetsWorker({
  name: "gatekeeper-caldav",
  entrypoint: ".wrangler/validate/src/index.ts",
  compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_compat"],
  observability: OBSERVABILITY,
});

export const wrangler = {
  build: CAPNWEB_VALIDATE_BUILD,
} satisfies WranglerExtras;

export const migrations: DurableObjectMigration[] = [
  { tag: "v0", new_sqlite_classes: ["UserAccount", "CalDavGatekeeperImpl"] },
];
