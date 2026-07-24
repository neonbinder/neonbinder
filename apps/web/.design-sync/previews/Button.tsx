import { Button } from "neonbinder";

const PlusIcon = () => (
  <svg
    className="w-4 h-4"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M12 4.5v15m7.5-7.5h-15"
    />
  </svg>
);

export const Default = () => <Button>Save Changes</Button>;

export const Variants = () => (
  <div className="flex flex-wrap items-center gap-3">
    <Button variant="default">Default</Button>
    <Button variant="primary">Primary</Button>
    <Button variant="destructive">Destructive</Button>
    <Button variant="outline">Outline</Button>
    <Button variant="subtle">Subtle</Button>
    <Button variant="ghost">Ghost</Button>
    <Button variant="link">Link</Button>
  </div>
);

export const WithIcon = () => (
  <div className="flex items-center gap-3">
    <Button variant="withIcon" icon={<PlusIcon />}>
      Add Card
    </Button>
    <Button variant="justIcon" icon={<PlusIcon />} aria-label="Add card" />
    <Button
      variant="justIconCircle"
      icon={<PlusIcon />}
      aria-label="Add card"
    />
  </div>
);

export const States = () => (
  <div className="flex items-center gap-3">
    <Button disabled>Disabled</Button>
    <Button isLoading>Loading</Button>
  </div>
);

export const Sizes = () => (
  <div className="flex items-center gap-3">
    <Button size="default">Default size</Button>
    <Button size="small">Small size</Button>
  </div>
);
