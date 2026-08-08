import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge Tailwind class names: clsx handles conditional/array inputs, and
 * tailwind-merge resolves conflicting utilities (so a later `className` prop
 * can reliably override a component's default classes).
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
