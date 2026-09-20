import { Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  CalDavSubscriptionConfiguratorRpc,
  CalDavSubscriptionConfiguratorValues,
} from "./caldav-subscription-configurator-types";

// A subscription connection is one published calendar link, fixed when it was connected, so there
// is nothing to pick here; the connect modal still requires a configurator per SupportedResource.

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
        label="Subscribed calendar"
        description="This binding can read events and busy time from the published calendar link you connected. Subscribed calendars are read-only: events on them cannot be created, changed, or deleted.">
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<CalDavSubscriptionConfiguratorRpc, CalDavSubscriptionConfiguratorValues>;
