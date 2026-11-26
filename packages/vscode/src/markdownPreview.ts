/**
 * The rendered preview of a Markdown change, as HTML: VS Code's own Markdown renderer makes it
 * from the source the profile prepares (`renderSource`, with the changed text marked); this module
 * takes the marks out of tags and keeps images to the project's files, without `vscode`, so it is
 * tested on its own.
 */

/** Marks taken out of the HTML's tags (a link's URL, an image's alt text), written as they are or percent-encoded. */
export function cleanTags(html: string): string {
  return html.replace(/<[^>]*>/g, (tag) => tag.replace(/[]|%EE%80%8[01]/gi, ""));
}

/**
 * Images of the rendered HTML from the project's files: `resolve` gives a relative source's
 * webview URI, or null to leave it out. Other sources (URLs, `data:`) are dropped: the page loads
 * nothing from the network.
 */
export function localImages(html: string, resolve: (path: string) => string | null): string {
  return html.replace(/(<img\b[^>]*?\ssrc=)(["'])([^"']*)\2/gi, (_m, head: string, q: string, src: string) => {
    let path: string | null = null;
    if (src && !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(src)) {
      try {
        path = decodeURI(src.replace(/[?#].*$/, "").replace(/&amp;/g, "&"));
      } catch {
        path = null;
      }
    }
    const uri = path ? resolve(path) : null;
    return `${head}${q}${uri ? uri.replace(/"/g, "%22") : ""}${q}`;
  });
}
