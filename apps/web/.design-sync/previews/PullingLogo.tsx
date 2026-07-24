import { PullingLogo } from "neonbinder";

// PullingLogo hard-codes src="/logo.png" (root-relative to the app's public/
// dir) — there is no prop to override it. In an isolated preview sandbox
// there is no such file served, so the <img> will render broken/missing.
// This is a real, permanent constraint of the component, not a preview bug —
// flagged for NOTES.md rather than worked around.
export const Default = () => <PullingLogo />;

export const Sizes = () => (
  <div className="flex items-end gap-6">
    <PullingLogo size="small" />
    <PullingLogo size="medium" />
    <PullingLogo size="large" />
  </div>
);

export const Animated = () => <PullingLogo size="large" animate />;
