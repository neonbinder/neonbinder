import { Avatar } from "neonbinder";

export const Default = () => <Avatar fallback="JB" />;

export const Sizes = () => (
  <div className="flex items-center gap-3">
    <Avatar fallback="JB" size="small" />
    <Avatar fallback="SL" size="medium" />
    <Avatar fallback="BSC" size="large" />
  </div>
);

export const CollectorRow = () => (
  <div className="flex items-center gap-3">
    <Avatar fallback="JB" size="medium" alt="Jason Burich" />
    <div className="flex flex-col">
      <span className="text-sm font-medium text-slate-900">
        Jason Burich
      </span>
      <span className="text-xs text-slate-500">412 cards in binder</span>
    </div>
  </div>
);
