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
      <div
        ref={ref}
        role="alert"
        className="rounded-lg p-4"
        style={{
          backgroundColor: "rgba(255, 46, 154, 0.1)",
          border: "2px solid #FF2E9A",
        }}
      >
        <p className="text-sm font-medium" style={{ color: "#FF2E9A" }}>
          Error: {error}
        </p>
      </div>
    );
  },
);

ErrorAlert.displayName = "ErrorAlert";
