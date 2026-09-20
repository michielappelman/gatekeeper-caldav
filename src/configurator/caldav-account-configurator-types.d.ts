export type CalDavAccountConfiguratorValues = {
  /**
   * No user-selectable values: connecting the account grants access to all of its calendars. A
   * placeholder field gives `isReady` something to check.
   */
  confirmed?: string | null;
};

export interface CalDavAccountConfiguratorRpc {
  /** Returns the canonical whole-account resource URL. */
  resourceUrl(): Promise<string>;
}
