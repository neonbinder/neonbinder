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
      "inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors focus-outline disabled:pointer-events-none disabled:opacity-50";

    const sizeClasses = {
      default: "px-4 py-2 text-sm leading-6",
      small: "px-3 py-1.5 text-sm leading-5",
    };

    const variantClasses = {
      default: "bg-neon-green text-on-neon-green hover:bg-neon-green-hover",
      primary: "bg-neon-green text-on-neon-green hover:bg-neon-green-hover",
      // Black ink, like NeonButton: white on neon pink is 3.44:1 (SC 1.4.3).
      destructive: "bg-neon-pink text-on-neon-pink hover:bg-neon-pink-hover",
      outline:
        "border border-control bg-raised text-ink hover:bg-hover",
      subtle: "bg-hover text-ink hover:bg-raised",
      ghost: "text-ink hover:bg-hover",
      link: "text-ink underline-offset-4 hover:underline",
      withIcon: "bg-neon-green text-on-neon-green hover:bg-neon-green-hover",
      justIcon: "p-2 text-ink hover:bg-hover",
      justIconCircle: "p-2 rounded-full text-ink hover:bg-hover",
      loading: "bg-hover text-ink-2",
    };

    const classes = `${baseClasses} ${sizeClasses[size]} ${variantClasses[variant]} ${className}`;

    const content = isLoading ? (
      <>
        <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
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
