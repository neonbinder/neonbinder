import React from "react";

interface ErrorAlertProps {
  error: string | null;
}

export const ErrorAlert = React.forwardRef<HTMLDivElement, ErrorAlertProps>(
  ({ error }, ref) => {
    if (!error) return null;

    return (
      // role="alert" is an implicit assertive live region: when an error
      // boundary swaps content for this alert, screen readers announce it —
      // without it the swap is silent (WCAG 4.1.3).
      // Pink is the app's one "stop" hue: a 10% wash, a full-strength edge, and
      // the pink deepened for text in light (#C40068, 5.3:1 on the wash).
      <div
        ref={ref}
        role="alert"
        className="rounded-lg p-4 bg-neon-pink/10 border-2 border-neon-pink"
      >
        <p className="text-sm font-medium text-neon-pink-text">
          Error: {error}
        </p>
      </div>
    );
  },
);

ErrorAlert.displayName = "ErrorAlert";
