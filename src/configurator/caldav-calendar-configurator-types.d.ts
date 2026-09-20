/**
 * Autocomplete row a configurator RPC returns. Local so server code can import configurator types
 * without pulling `@gadgets/configurator-ui`'s global `JSX`.
 */
export type ConfiguratorOption = {
  value: string;
  title: string;
  subtitle?: string;
  meta?: string;
};

export type CalDavCalendarConfiguratorValues = {
  calendarId?: string | null;
};

export interface CalDavCalendarConfiguratorRpc {
  /** Lists the connected account's event calendars whose name matches `query`. */
  listCalendars(query: string): Promise<ConfiguratorOption[]>;
}
