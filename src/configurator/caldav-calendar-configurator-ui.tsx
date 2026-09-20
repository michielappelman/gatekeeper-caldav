import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  CalDavCalendarConfiguratorRpc,
  CalDavCalendarConfiguratorValues,
} from "./caldav-calendar-configurator-types";

// Mirrors toCalendarResourceUrl()/parseResourceUrl() in ../resource.ts; configurator modules are
// transpiled standalone and cannot import runtime helpers.
const CALENDAR_URL_PREFIX = "https://caldav.local/calendar/";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.calendarId === "string" && values.calendarId.length > 0;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    if (!resourceUrl.startsWith(CALENDAR_URL_PREFIX)) return {};
    try {
      return { calendarId: decodeURIComponent(resourceUrl.slice(CALENDAR_URL_PREFIX.length)) };
    } catch {
      return {};
    }
  },

  resourceUrl({ values }) {
    return `${CALENDAR_URL_PREFIX}${encodeURIComponent(values.calendarId ?? "")}`;
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field label="Calendar" description="Choose the calendar this connection can read and manage.">
        <Autocomplete
          name="calendarId"
          value={values.calendarId}
          placeholder="Search calendars..."
          loadOptions={query => ui.listCalendars(query)}
          onChange={calendarId => setValues({ calendarId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<CalDavCalendarConfiguratorRpc, CalDavCalendarConfiguratorValues>;
