// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import React from "react";

type IconName =
  | "ban"
  | "book"
  | "chevron"
  | "close"
  | "crosshair"
  | "drag"
  | "edit"
  | "eye"
  | "fire"
  | "help"
  | "link"
  | "lock"
  | "mic"
  | "pin"
  | "pause"
  | "play"
  | "refresh"
  | "seal"
  | "sparkle"
  | "stop"
  | "volume"
  | "user";

const paths: Record<IconName, React.ReactNode> = {
  ban: <><circle cx="12" cy="12" r="8.5" /><path d="m6 6 12 12" /></>,
  book: <><path d="M4 5.5c2.4-.9 4.8-.7 7 1v12c-2.2-1.7-4.6-1.9-7-1V5.5Z" /><path d="M20 5.5c-2.4-.9-4.8-.7-7 1v12c2.2-1.7 4.6-1.9 7-1V5.5Z" /></>,
  chevron: <path d="m9 6 6 6-6 6" />,
  close: <><path d="m6 6 12 12" /><path d="m18 6-12 12" /></>,
  crosshair: <><circle cx="12" cy="12" r="6" /><path d="M12 2v4M12 18v4M2 12h4M18 12h4" /></>,
  drag: <><path d="M8 7h8M8 12h8M8 17h8" /><circle cx="5" cy="7" r=".5" /><circle cx="5" cy="12" r=".5" /><circle cx="5" cy="17" r=".5" /></>,
  edit: <><path d="M4 20h4l11-11-4-4L4 16v4Z" /><path d="m13.5 6.5 4 4" /></>,
  eye: <><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6S2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="2.5" /></>,
  fire: <path d="M13.5 2.5c.8 4-2 5.2-2 7.6 0 1.1.7 1.9 1.7 1.9 1.5 0 2.3-1.5 2.2-3.3 2.2 1.9 3.5 4.1 3.2 6.6-.4 3.8-3.4 6.2-7 6.2-4.1 0-7.2-2.8-7.2-6.8 0-3.2 2-5.8 5-8.4-.2 2.6.6 4 1.8 4.2.4-2.9 1.1-5.5 2.3-8Z" />,
  help: <><circle cx="12" cy="12" r="9" /><path d="M9.8 9.1a2.4 2.4 0 0 1 4.7.7c0 1.8-2.5 2-2.5 3.8" /><path d="M12 17h.01" /></>,
  link: <><path d="M10 13a4 4 0 0 0 5.7 0l2-2a4 4 0 0 0-5.7-5.7l-1.1 1.1" /><path d="M14 11a4 4 0 0 0-5.7 0l-2 2A4 4 0 0 0 12 18.7l1.1-1.1" /></>,
  lock: <><rect x="5" y="10" width="14" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
  mic: <><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M9 21h6" /></>,
  pin: <><path d="m8 3 8 0-1.2 6 3.2 3H6l3.2-3L8 3Z" /><path d="M12 12v9" /></>,
  pause: <><path d="M8 5v14" /><path d="M16 5v14" /></>,
  play: <path d="m8 5 11 7-11 7V5Z" />,
  refresh: <><path d="M20 7v5h-5" /><path d="M4 17v-5h5" /><path d="M6.1 8.2A7 7 0 0 1 18.6 7L20 12M4 12l1.4 5a7 7 0 0 0 12.5-1.2" /></>,
  seal: <><rect x="4" y="4" width="16" height="16" rx="1" /><path d="M8 8h8v8H8zM8 12h8M12 8v8" /></>,
  sparkle: <><path d="m12 2 1.1 4.2L17 8l-3.9 1.8L12 14l-1.1-4.2L7 8l3.9-1.8L12 2Z" /><path d="m5 14 .7 2.3L8 17l-2.3.7L5 20l-.7-2.3L2 17l2.3-.7L5 14Z" /></>,
  stop: <rect x="6" y="6" width="12" height="12" rx="1" />,
  volume: <><path d="M4 10v4h4l5 4V6l-5 4H4Z" /><path d="M16 9a4 4 0 0 1 0 6" /><path d="M18.5 6.5a7.5 7.5 0 0 1 0 11" /></>,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4.5 21a7.5 7.5 0 0 1 15 0" /></>,
};

export function DeskIcon({
  name,
  size = 20,
  className,
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.7"
    >
      {paths[name]}
    </svg>
  );
}
