import React from "react";

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?:
    | "default"
    | "primary"
    | "destructive"
    | "outline"
    | "subtle"
    | "ghost"
    | "link"
    | "withIcon"
    | "justIcon"
    | "justIconCircle"
    | "loading";
  size?: "default" | "small";
  children?: React.ReactNode;
  icon?: React.ReactNode;
  isLoading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = "default",
      size = "default",
      children,
      icon,
      isLoading,
      className = "",
      ...props
    },
    ref,
  ) => {
    const baseClasses =
      "inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";

    const sizeClasses = {
      default: "px-4 py-2 text-sm leading-6",
      small: "px-3 py-1.5 text-sm leading-5",
    };

    const variantClasses = {
      default: "bg-neon-green text-black hover:bg-neon-green/85",
      primary: "bg-neon-green text-black hover:bg-neon-green/85",
      destructive: "bg-neon-pink text-white hover:bg-neon-pink/90",
      outline:
        "border border-slate-300 bg-white text-slate-900 hover:bg-slate-50",
      subtle: "bg-slate-100 text-slate-900 hover:bg-slate-200",
      ghost: "text-slate-900 hover:bg-slate-100",
      link: "text-slate-900 underline-offset-4 hover:underline",
      withIcon: "bg-neon-green text-black hover:bg-neon-green/85",
      justIcon: "p-2 text-slate-900 hover:bg-slate-100",
      justIconCircle: "p-2 rounded-full text-slate-900 hover:bg-slate-100",
      loading: "bg-slate-600 text-white",
    };

    const classes = `${baseClasses} ${sizeClasses[size]} ${variantClasses[variant]} ${className}`;

    const content = isLoading ? (
      <>
        <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
        {children}
      </>
    ) : (
      <>
        {icon && <span className="w-4 h-4">{icon}</span>}
        {children}
      </>
    );

    return (
      <button ref={ref} className={classes} disabled={isLoading} {...props}>
        {content}
      </button>
    );
  },
);

Button.displayName = "Button";
