import React from "react";

export interface AvatarProps {
  src?: string;
  alt?: string;
  fallback?: string;
  size?: "small" | "medium" | "large";
  className?: string;
}

export const Avatar: React.FC<AvatarProps> = ({
  src,
  alt,
  fallback,
  size = "medium",
  className = "",
}) => {
  const sizeClasses = {
    small: "w-8 h-8 text-xs",
    medium: "w-10 h-10 text-sm",
    large: "w-12 h-12 text-base",
  };

  const baseClasses = `inline-flex items-center justify-center rounded-full bg-slate-200 text-slate-900 font-medium ${sizeClasses[size]} ${className}`;

  if (src) {
    return (
      <img
        src={src}
        alt={alt || "Avatar"}
        width={40}
        height={40}
        loading="lazy"
        className={`${baseClasses} object-cover`}
      />
    );
  }

  return <div className={baseClasses}>{fallback || "?"}</div>;
};
