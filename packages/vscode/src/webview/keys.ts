/** What keys do in the PDF preview page, and its pictures' alt text: plain functions, run in the webview and tested here. */

/**
 * What a key does to a page in its frame, as the mouse does: the arrow keys move it (by a tenth of
 * how far it can move), + and − zoom. Null for other keys.
 */
export function frameKey(key: string): { move: [number, number]; zoom?: undefined } | { zoom: number; move?: undefined } | null {
  const step = 0.1;
  const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
  if (moves[key]) return { move: moves[key] };
  if (key === "+" || key === "=") return { zoom: 1.25 };
  if (key === "-") return { zoom: 0.8 };
  return null;
}

/**
 * What a key does in the page viewer: Page Down and Page Up turn the shown version's pages, A and
 * B show the page after and before the change. Null when the key does nothing there.
 */
export function viewerKey(
  key: string,
  s: { side: "after" | "before"; shown: { after: number; before: number }; count: number; hasBefore: boolean },
): { side: "after" | "before"; page: number } | null {
  if (key === "PageDown" && s.shown[s.side] < s.count) return { side: s.side, page: s.shown[s.side] + 1 };
  if (key === "PageUp" && s.shown[s.side] > 1) return { side: s.side, page: s.shown[s.side] - 1 };
  if (key === "a" || key === "A") return { side: "after", page: s.shown.after };
  if ((key === "b" || key === "B") && s.hasBefore) return { side: "before", page: s.shown.before };
  return null;
}

/** The alt text of a page picture: which page, with or without the change, what the change is, and how many places are marked. */
export function pageAlt(page: number, side: "after" | "before", what: string, marks: number): string {
  return `Page ${page} ${side === "after" ? "with" : "without"} the change: ${what}` + (marks ? `, ${marks} changed place${marks > 1 ? "s" : ""} marked` : "");
}
