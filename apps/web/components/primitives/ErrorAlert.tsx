import React from "react";

interface ErrorAlertProps {
  error: string | null;
}

export const ErrorAlert = React.forwardRef<HTMLDivElement, ErrorAlertProps>(
  ({ error }, ref) => {
    if (!error) return null;

    return (
      <div
        ref={ref}
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
