/**
 * HTML from a notebook, as nodes that are safe to show on the desktop. A
 * notebook comes from a cloned repository and its saved outputs and Markdown
 * are whatever its author wrote, while the desktop's page holds the person's
 * sign-ins. So the HTML is parsed in a document that runs nothing, and only
 * a fixed set of elements and attributes is copied out of it: no scripts, no
 * event handlers, no frames, no forms, no style sheets, no links that are
 * not http(s).
 */

const ALLOWED = new Set([
  'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'center', 'cite', 'code', 'col', 'colgroup', 'dd', 'del', 'details', 'div', 'dl', 'dt',
  'em', 'figcaption', 'figure', 'font', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre',
  'q', 's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'tt', 'u', 'ul', 'var',
]);
/** Dropped with everything inside them (other unknown elements keep their text) */
const DROPPED = new Set(['script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'link', 'meta', 'base', 'head', 'title', 'template', 'noscript', 'svg', 'math', 'form', 'input', 'button', 'select', 'option', 'textarea', 'audio', 'video', 'source', 'track', 'canvas', 'dialog']);
const ATTRS = new Set(['colspan', 'rowspan', 'align', 'valign', 'title', 'alt', 'width', 'height', 'start', 'type', 'open', 'color', 'size', 'border', 'cellpadding', 'cellspacing', 'scope']);
const STYLE_PROPS = /^(color|background-color|background|text-align|font-weight|font-style|font-size|font-family|text-decoration|white-space|vertical-align|width|min-width|max-width|height|border(-(top|right|bottom|left))?(-(color|style|width))?|border-collapse|padding(-(top|right|bottom|left))?|margin(-(top|right|bottom|left))?|opacity|display)$/;
const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=\s]+$/;

export interface SanitizeOptions {
  /**
   * An image whose address is not a web address or image data (a path beside
   * the notebook, `attachment:name`): called with the element to fill in
   * later. It returns false for one it cannot show; without it, and for
   * those, the image is left out.
   */
  image?(img: HTMLImageElement, src: string): boolean;
}

function safeStyle(text: string): string {
  const out: string[] = [];
  for (const decl of text.split(';')) {
    const colon = decl.indexOf(':');
    if (colon < 0) continue;
    const prop = decl.slice(0, colon).trim().toLowerCase();
    const value = decl.slice(colon + 1).trim();
    if (!STYLE_PROPS.test(prop) || /url\s*\(|expression|javascript:|@import|\\/i.test(value)) continue;
    if (prop === 'display' && !/^(none|block|inline|inline-block|table|table-cell|table-row)$/i.test(value)) continue;
    out.push(`${prop}: ${value}`);
  }
  return out.join('; ');
}

function copy(from: Node, to: Node, doc: Document, opts: SanitizeOptions): void {
  for (const node of Array.from(from.childNodes)) {
    if (node.nodeType === 3) { to.appendChild(doc.createTextNode(node.nodeValue ?? '')); continue; }
    if (node.nodeType !== 1) continue;
    const el = node as Element;
    const tag = el.localName;
    if (DROPPED.has(tag)) continue;
    if (!ALLOWED.has(tag)) { copy(el, to, doc, opts); continue; }
    const out = doc.createElement(tag);
    let later = false;
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value;
      if (ATTRS.has(name)) out.setAttribute(name, value);
      else if (name === 'class') {
        // (only the class the table style reads: a notebook cannot dress as the desktop)
        if (/\bdataframe\b/.test(value)) out.setAttribute('class', 'dataframe');
      } else if (name === 'style') {
        const style = safeStyle(value);
        if (style) out.setAttribute('style', style);
      } else if (name === 'href' && tag === 'a') {
        if (/^(https?:|mailto:)/i.test(value.trim())) {
          out.setAttribute('href', value.trim());
          out.setAttribute('target', '_blank');
          out.setAttribute('rel', 'noopener noreferrer');
        }
      } else if (name === 'src' && tag === 'img') {
        const src = value.trim();
        if (DATA_IMAGE.test(src) || /^https?:\/\//i.test(src)) {
          out.setAttribute('src', src);
          out.setAttribute('referrerpolicy', 'no-referrer');
        } else if (opts.image && src && !/^[a-z][a-z0-9+.-]*:/i.test(src.replace(/^attachment:/i, ''))) {
          later = opts.image(out as HTMLImageElement, src);
        }
      }
    }
    if (tag === 'img') {
      if (!later && !out.hasAttribute('src')) continue;
      out.setAttribute('loading', 'lazy');
    }
    copy(el, out, doc, opts);
    to.appendChild(out);
  }
}

/** `html` as a fragment of the page's document that holds only allowed elements */
export function sanitizeHtml(html: string, opts: SanitizeOptions = {}): DocumentFragment {
  const parsed = new DOMParser().parseFromString(`<!doctype html><body>${html}`, 'text/html');
  const frag = document.createDocumentFragment();
  copy(parsed.body, frag, document, opts);
  return frag;
}
