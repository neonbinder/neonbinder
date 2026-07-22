import { Textarea } from "neonbinder";

export const Default = () => (
  <Textarea
    label="Listing notes"
    helperText="Visible to buyers on eBay, SportLots, and BuySportsCards listings."
    placeholder="Describe centering, corners, and any surface flaws..."
  />
);

export const WithButton = () => (
  <Textarea
    label="Message to seller"
    variant="withButton"
    buttonText="Send message"
    placeholder="Ask about the 2003 Topps Chrome LeBron James rookie..."
  />
);

export const Disabled = () => (
  <Textarea
    label="Listing notes"
    helperText="Locked while this card is pending marketplace sync"
    state="disabled"
    defaultValue="PSA 9 - sharp corners, slight surface scratch near left border."
  />
);
