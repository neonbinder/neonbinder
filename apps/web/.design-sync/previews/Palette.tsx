import { Palette } from "neonbinder";

export const NeonBrandRow = () => (
  <div className="flex flex-wrap gap-4">
    <Palette color="#00D558" name="Neon Green" shade="500" />
    <Palette color="#FF2E9A" name="Neon Pink" shade="500" />
    <Palette color="#FFE600" name="Neon Yellow" shade="500" />
    <Palette color="#00C2FF" name="Neon Blue" shade="500" />
    <Palette color="#A44AFF" name="Neon Purple" shade="500" />
    <Palette color="#FF9E00" name="Neon Orange" shade="500" />
  </div>
);

export const NeutralRow = () => (
  <div className="flex flex-wrap gap-4">
    <Palette color="#0F172A" name="Slate" shade="900" />
    <Palette color="#64748B" name="Slate" shade="500" />
    <Palette color="#E2E8F0" name="Slate" shade="200" />
  </div>
);
