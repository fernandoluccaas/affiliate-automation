import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { LoaderCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export const buttonVariants = cva(
  "inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-[var(--radius-md)] px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--background)] disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "bg-[var(--primary)] text-[var(--primary-foreground)] hover:bg-[var(--primary-hover)]",
        primary:
          "bg-[var(--primary)] text-[var(--primary-foreground)] hover:bg-[var(--primary-hover)]",
        secondary:
          "bg-[var(--primary-subtle)] text-[var(--primary)] hover:bg-[color-mix(in_srgb,var(--primary-subtle)_75%,var(--border))]",
        outline:
          "border border-[var(--border-strong)] bg-[var(--surface)] text-[var(--foreground)] hover:bg-[var(--muted)]",
        ghost:
          "text-[var(--foreground-secondary)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]",
        danger: "bg-[var(--danger)] text-white hover:brightness-90",
        link: "min-h-0 rounded-sm px-1 py-0 text-[var(--primary)] underline-offset-4 hover:underline",
      },
      size: {
        default: "min-h-11 px-4",
        sm: "min-h-9 px-3 text-xs",
        lg: "min-h-12 px-5",
        icon: "size-11 px-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
  loadingLabel?: string;
}

/**
 * Renders a native button by default. With `asChild`, Radix Slot receives the
 * single child unchanged and applies the button props to that element.
 *
 * Loading an `asChild` button keeps its child content (including its accessible
 * name), marks it busy/disabled and blocks activation. The visual spinner and
 * `loadingLabel` are intentionally exclusive to native buttons so Slot never
 * receives auxiliary siblings.
 */
export const Button = React.forwardRef<HTMLElement, ButtonProps>(
  function Button(
    {
      className,
      variant,
      size,
      asChild = false,
      loading = false,
      loadingLabel,
      children,
      disabled,
      onClick,
      ...props
    },
    ref,
  ) {
    const classNames = cn(buttonVariants({ variant, size, className }));
    const ariaBusy = loading ? true : props["aria-busy"];
    const ariaDisabled =
      disabled || loading ? true : props["aria-disabled"];

    if (asChild) {
      return (
        <Slot
          ref={ref}
          {...props}
          className={classNames}
          aria-busy={ariaBusy}
          aria-disabled={ariaDisabled}
          onClick={(event) => {
            if (disabled || loading) {
              event.preventDefault();
              event.stopPropagation();
              return;
            }
            onClick?.(event as React.MouseEvent<HTMLButtonElement>);
          }}
        >
          {children}
        </Slot>
      );
    }

    return (
      <button
        ref={ref as React.Ref<HTMLButtonElement>}
        {...props}
        className={classNames}
        disabled={disabled || loading}
        aria-busy={ariaBusy}
        onClick={onClick}
      >
        {loading ? (
          <LoaderCircle aria-hidden="true" className="animate-spin" size={17} />
        ) : null}
        {loading && loadingLabel ? loadingLabel : children}
      </button>
    );
  },
);
