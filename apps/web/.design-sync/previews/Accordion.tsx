import { Accordion } from "neonbinder";

const items = [
  {
    id: "grading",
    trigger: "What grading services do you support?",
    content: "PSA, BGS, SGC, and CGC certified cards are all supported.",
  },
  {
    id: "marketplaces",
    trigger: "Which marketplaces can I list on?",
    content: "eBay, SportLots, BuySportsCards, MySlabs, and MyCardPost.",
  },
  {
    id: "disabled",
    trigger: "Bulk import (coming soon)",
    content: "Not available yet.",
    disabled: true,
  },
];

// Accordion has no defaultOpen/controlled-open prop — open/expanded is
// internal useState that only changes via click, so every instance mounts
// fully collapsed regardless of `type`. A static capture can't show the
// expanded state (interaction-only); see NOTES.md.
export const Default = () => <Accordion items={items} />;
