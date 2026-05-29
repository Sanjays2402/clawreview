import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { cn } from './cn.js';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-fg text-bg hover:bg-fg/90 active:bg-fg/80 disabled:opacity-50',
  secondary:
    'border border-border bg-bg-subtle text-fg hover:bg-bg-muted disabled:opacity-50',
  ghost:
    'text-fg-muted hover:text-fg hover:bg-bg-subtle disabled:opacity-50',
  danger:
    'bg-severity-critical text-white hover:bg-severity-critical/90 disabled:opacity-50',
};

const SIZES: Record<Size, string> = {
  sm: 'h-8 px-3 text-xs',
  md: 'h-9 px-4 text-sm',
  lg: 'h-11 px-5 text-sm',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  leading?: ReactNode;
  trailing?: ReactNode;
}

export function Button({
  variant = 'primary',
  size = 'md',
  className,
  leading,
  trailing,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {leading}
      {children}
      {trailing}
    </button>
  );
}
