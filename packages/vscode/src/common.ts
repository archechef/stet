/** What the extension's parts share: the tree element, and the notification modes as offered. */
import type { NotifyMode } from "@stet/core";
import type { Node } from "./model.js";
import type { Project } from "./project.js";

export type El = { project: Project; node?: Node };

/** The notification modes as offered in the panel. */
export const NOTIFY_PICKS: { mode: NotifyMode; label: string; detail: string }[] = [
  { mode: "batched", label: "When I pause", detail: "Once you have stopped for half a minute, with all your decisions together. Not after every click." },
  { mode: "now", label: "Right away", detail: "At each decision, comment or note." },
  {
    mode: "off",
    label: "Off",
    detail: "Not woken: the agent hears about your decisions when it next checks. Switching back on delivers what arrived meanwhile.",
  },
];
