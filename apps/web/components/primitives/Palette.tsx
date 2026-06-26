import React from "react";

export interface PaletteProps {
  color: string;
  name: string;
  shade: string;
  className?: string;
}

export const Palette: React.FC<PaletteProps> = ({
  color,
  shade,
  className = "",
}) => {
  return (
    <div className={`flex flex-col items-center gap-2 ${className}`}>
      <div
        className="w-14 h-10 rounded border border-slate-200"
        style={{ backgroundColor: color }}
      />
      <div className="flex flex-col items-center">
        <span className="text-xs font-medium text-slate-900">{shade}</span>
        <span className="text-xs text-slate-400">{color}</span>
      </div>
    </div>
  );
};
