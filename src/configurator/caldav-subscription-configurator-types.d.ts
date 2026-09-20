export type CalDavSubscriptionConfiguratorValues = {
  /**
   * No user-selectable values: the calendar link was chosen when the connection was created. A
   * placeholder field gives `isReady` something to check.
   */
  confirmed?: string | null;
};

export interface CalDavSubscriptionConfiguratorRpc {
  /** Returns the canonical subscribed-calendar resource URL. */
  resourceUrl(): Promise<string>;
}
