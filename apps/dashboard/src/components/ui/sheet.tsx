"use client";

import React from "react";
import { Dialog } from "@/components/ui/dialog";

export function Sheet(
  props: Omit<React.ComponentProps<typeof Dialog>, "placement"> & {
    side?: "left" | "right";
  },
) {
  return <Dialog {...props} placement={props.side ?? "left"} />;
}
