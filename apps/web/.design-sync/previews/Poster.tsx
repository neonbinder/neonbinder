import { Poster } from "neonbinder";

export const Default = () => (
  <Poster
    title="2024 Topps Chrome"
    description="Shop the newest Chrome refractors added to the binder this week."
  />
);

export const Pair = () => (
  <div className="flex flex-wrap gap-4">
    <Poster
      title="2024 Topps Chrome"
      description="Shop the newest Chrome refractors added to the binder this week."
    />
    <Poster
      title="Bowman Draft Preview"
      description="Get first look at rookie prospects before the set drops on eBay."
    />
  </div>
);
