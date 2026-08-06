"use client";

import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { LoaderCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  buttonVariants,
  type ButtonVariantProps,
} from "@/components/ui/button-variants";

export interface ButtonProps
  extends
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    ButtonVariantProps {
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
