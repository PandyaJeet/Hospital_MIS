"use client";

import * as React from "react";
import { AlertCircle } from "lucide-react";

import { cn } from "@/lib/utils/cn";

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  helperText?: string;
}

/**
 * Text input with label-above-field (Design.md §5).
 *
 * Note: validation errors use `warning` (amber) + an icon, not `critical` red.
 * Design.md §2 reserves red exclusively for genuine clinical urgency and calls
 * for a non-red treatment on generic form errors.
 */
export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, label, error, helperText, id, ...props }, ref) => {
    const generatedId = React.useId();
    const inputId = id ?? generatedId;
    const messageId = error
      ? `${inputId}-error`
      : helperText
        ? `${inputId}-helper`
        : undefined;

    return (
      <div className="flex flex-col gap-1.5">
        {label ? (
          <label
            htmlFor={inputId}
            className="text-sm font-medium text-text-primary"
          >
            {label}
          </label>
        ) : null}
        <input
          ref={ref}
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={messageId}
          className={cn(
            "h-11 rounded-md border bg-surface px-3 text-base text-text-primary",
            "placeholder:text-text-disabled",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            "disabled:cursor-not-allowed disabled:bg-surface-muted",
            error ? "border-warning" : "border-border",
            className,
          )}
          {...props}
        />
        {error ? (
          <p
            id={`${inputId}-error`}
            className="flex items-center gap-1.5 text-sm text-text-secondary"
          >
            <AlertCircle className="h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
            {error}
          </p>
        ) : helperText ? (
          <p id={`${inputId}-helper`} className="text-sm text-text-secondary">
            {helperText}
          </p>
        ) : null}
      </div>
    );
  },
);
Input.displayName = "Input";
