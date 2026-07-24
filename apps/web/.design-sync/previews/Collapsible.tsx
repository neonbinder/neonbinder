import { Collapsible } from "neonbinder";

export const Collapsed = () => (
  <Collapsible trigger="Shipping details" defaultOpen={false}>
    <p className="text-sm text-slate-700">
      Cards ship in a rigid mailer within 2 business days of purchase.
    </p>
  </Collapsible>
);

export const Expanded = () => (
  <Collapsible trigger="Grading notes" defaultOpen={true}>
    <p className="text-sm text-slate-700">
      PSA 9 or better recommended for vintage inventory listed above $50.
    </p>
    <p className="text-sm text-slate-700">
      Raw cards should include front and back scans before listing.
    </p>
  </Collapsible>
);
