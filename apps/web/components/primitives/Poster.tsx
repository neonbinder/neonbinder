import React from "react";

export interface PosterProps {
  title: string;
  description: string;
  icon?: React.ReactNode;
  className?: string;
}

export const Poster: React.FC<PosterProps> = ({
  title,
  description,
  icon,
  className = "",
}) => {
  return (
    <div className={`w-47 h-67.5 relative ${className}`}>
      <div className="w-full h-full flex-shrink-0 rounded bg-gradient-to-b from-pink-500 via-purple-600 to-indigo-700" />
      <div className="w-35 h-36.5 flex-shrink-0 absolute left-6 top-25">
        <div className="inline-flex flex-col items-start gap-5 absolute left-0 top-0 w-35 h-36.5">
          {icon && <div className="w-5.5 h-5.5 fill-white">{icon}</div>}
          <div className="flex flex-col items-start gap-2">
            <div className="text-white text-lg font-medium leading-6">
              {title}
            </div>
            <div className="w-35 text-slate-200 text-sm font-normal leading-4.5 tracking-tight">
              {description}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
