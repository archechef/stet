/**
 * Highlights in a rendered change (Markdown): the HTML's text has the change between two marks
 * (`markdownPreview.ts`), which may lie in different elements (a change across a list's items
 * or a table's cells). Every piece of text between them is wrapped in `<mark class="change">`,
 * and the marks themselves are taken out.
 */
const OPEN = "";
const CLOSE = "";

export function markChanges(root: Element): number {
  const texts: Text[] = [];
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) texts.push(n as Text);
  let inside = false;
  let marked = 0;
  for (const node of texts) {
    const value = node.data;
    if (!inside && !value.includes(OPEN)) continue;
    const parts = value.split(/([])/);
    const out = document.createDocumentFragment();
    for (const part of parts) {
      if (part === OPEN) inside = true;
      else if (part === CLOSE) inside = false;
      else if (part && inside && part.trim()) {
        const m = document.createElement("mark");
        m.className = "change";
        m.textContent = part;
        out.append(m);
        marked++;
      } else if (part) out.append(part);
    }
    node.replaceWith(out);
  }
  return marked;
}
