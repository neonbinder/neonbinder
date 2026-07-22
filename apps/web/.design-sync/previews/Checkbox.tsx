import { Checkbox } from "neonbinder";

export const Unchecked = () => <Checkbox label="Include graded cards only" />;

export const Checked = () => (
  <Checkbox label="Auto-relist expired eBay listings" checked readOnly />
);

export const WithDescription = () => (
  <Checkbox
    variant="withText"
    label="Sync prices across marketplaces"
    description="Applies your SportLots price to eBay and BuySportsCards listings whenever it changes."
    checked
    readOnly
  />
);

export const Disabled = () => (
  <Checkbox
    label="Enable MyCardPost sync"
    description="Requires a connected MyCardPost account"
    variant="withText"
    disabled
  />
);
