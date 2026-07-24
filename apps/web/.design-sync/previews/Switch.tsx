import { Switch } from "neonbinder";

export const Off = () => <Switch />;

export const On = () => <Switch checked readOnly />;

export const WithLabel = () => (
  <Switch label="Auto-list new cards to eBay" checked readOnly />
);
