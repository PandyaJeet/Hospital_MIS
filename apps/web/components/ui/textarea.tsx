"use client";

import * as React from "react";
import { AlertCircle } from "lucide-react";

import { cn } from "@/lib/utils/cn";

export interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
  helperText?: string;
}

/**
 * Multi-line text input. Same label-above + non-red error treatment as Input
 * (Design.md §2, §5).
 */
export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, label, error, helperText, id, ...props }, ref) => {
    const generatedId = React.useId();
    const textareaId = id ?? generatedId;
    const messageId = error
      ? `${textareaId}-error`
      : helperText
        ? `${textareaId}-helper`
        : undefined;

    return (
      <div className="flex flex-col gap-1.5">
        {label ? (
          <label
            htmlFor={textareaId}
            className="text-sm font-medium text-text-primary"
          >
            {label}
          </label>
        ) : null}
        <textarea
          ref={ref}
          id={textareaId}
          aria-invalid={error ? true : undefined}
          aria-describedby={messageId}
          className={cn(
            "min-h-20 rounded-md border bg-surface px-3 py-2 text-base text-text-primary",
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
            id={`${textareaId}-error`}
            className="flex items-center gap-1.5 text-sm text-text-secondary"
          >
            <AlertCircle
              className="h-4 w-4 shrink-0 text-warning"
              aria-hidden="true"
            />
            {error}
          </p>
        ) : helperText ? (
          <p id={`${textareaId}-helper`} className="text-sm text-text-secondary">
            {helperText}
          </p>
        ) : null}
      </div>
    );
  },
);
Textarea.displayName = "Textarea";
