import { Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  CalDavAccountConfiguratorRpc,
  CalDavAccountConfiguratorValues,
} from "./caldav-account-configurator-types";

// The whole-account resource has no inputs; the connect modal still requires a configurator for
// every SupportedResource, so this one only confirms what is being connected.

export default {
  initial: { confirmed: "yes" },

  isReady() {
    return true;
  },

  resourceUrl({ ui }) {
    return ui.resourceUrl();
  },

  render() {
    return <Section>
      <Field
        label="All calendars"
        description="This binding can read events and busy time across every calendar of the connected account, and create, change, or delete events on any calendar that is not read-only.">
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<CalDavAccountConfiguratorRpc, CalDavAccountConfiguratorValues>;
