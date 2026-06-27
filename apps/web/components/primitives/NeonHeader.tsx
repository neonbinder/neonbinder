import React from "react";

export interface NeonHeaderProps
  extends React.HTMLAttributes<HTMLHeadingElement> {
  children?: React.ReactNode;
}

export const NeonHeader = React.forwardRef<HTMLHeadingElement, NeonHeaderProps>(
  (
    {
      children = "Neon Binder",
      className = "",
      ...props
    },
    ref,
  ) => {
    return (
      <h1
        ref={ref}
        className={`text-6xl font-bold mb-4 bg-gradient-to-r from-green-400 to-blue-500 bg-clip-text text-transparent ${className}`}
        {...props}
      >
        {children}
      </h1>
    );
  },
);

NeonHeader.displayName = "NeonHeader";
