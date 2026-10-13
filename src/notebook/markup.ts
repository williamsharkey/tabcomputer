/**
 * Text to HTML for the Notebook app, without a DOM: Markdown cells and the
 * colors of a Python cell. What `markdownToHtml` returns may carry HTML the
 * author wrote; it is never put in the page as it is: sanitize.ts builds the
 * nodes that are shown.
 */

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// ── Markdown ──

const PLACEHOLDER = '\u0000';

function inline(text: string): string {
  const kept: string[] = [];
  const keep = (html: string) => `${PLACEHOLDER}${kept.push(html) - 1}${PLACEHOLDER}`;
  // code spans first: nothing inside them is markup
  let s = text.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_m, _t: string, code: string) => keep(`<code>${escapeHtml(code.trim())}</code>`));
  // math is left as typed (it is not drawn), and its underscores and stars are not emphasis
  s = s.replace(/\$\$[\s\S]+?\$\$|\$[^\s$][^$\n]*?\$/g, (m) => keep(escapeHtml(m)));
  // a `<` that does not start a tag is text
  s = s.replace(/<(?![A-Za-z/!])/g, '&lt;');
  s = s.replace(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"([^"]*)")?\s*\)/g, (_m, alt: string, src: string, title?: string) =>
    keep(`<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"${title ? ` title="${escapeHtml(title)}"` : ''}>`));
  s = s.replace(/\[([^\]]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"([^"]*)")?\s*\)/g, (_m, label: string, href: string, title?: string) =>
    `${keep(`<a href="${escapeHtml(href)}"${title ? ` title="${escapeHtml(title)}"` : ''}>`)}${label}${keep('</a>')}`);
  s = s.replace(/<(https?:\/\/[^\s>]+)>/g, (_m, url: string) => keep(`<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`));
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?])/g, (_m, pre: string, url: string) => `${pre}${keep(`<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`)}`);
  s = s.replace(/\*\*([^\s*](?:[\s\S]*?[^\s*])?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^\w])__([^\s_](?:[\s\S]*?[^\s_])?)__(?!\w)/g, '$1<strong>$2</strong>');
  s = s.replace(/\*([^\s*](?:[^*]*?[^\s*])?)\*/g, '<em>$1</em>');
  s = s.replace(/(^|[^\w])_([^\s_](?:[^_]*?[^\s_])?)_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(/ {2,}\n|\\\n/g, '<br>\n');
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => kept[Number(i)]);
}

const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

/** Markdown as HTML: headings, lists, tables, code, quotes, links, images, emphasis. Raw HTML passes through. */
export function markdownToHtml(source: string): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  const para: string[] = [];
  const flush = () => {
    if (para.length) { out.push(`<p>${inline(para.join('\n'))}</p>`); para.length = 0; }
  };
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*(```+|~~~+)\s*([\w+-]*)/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      out.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }
    if (!line.trim()) { flush(); i++; continue; }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) { flush(); out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`); i++; continue; }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push('<hr>'); i++; continue; }
    if (para.length && /^\s{0,3}(=+|-+)\s*$/.test(line)) {
      const level = line.trim()[0] === '=' ? 1 : 2;
      out.push(`<h${level}>${inline(para.join('\n'))}</h${level}>`);
      para.length = 0;
      i++;
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      flush();
      const body: string[] = [];
      while (i < lines.length && lines[i].trim() && (/^\s{0,3}>/.test(lines[i]) || body.length)) body.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
      out.push(`<blockquote>${markdownToHtml(body.join('\n'))}</blockquote>`);
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      flush();
      const head = tableCells(line);
      const align = tableCells(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : ''));
      i += 2;
      const cell = (tag: string, text: string, n: number) => `<${tag}${align[n] ? ` align="${align[n]}"` : ''}>${inline(text)}</${tag}>`;
      let html = `<table><thead><tr>${head.map((c, n) => cell('th', c, n)).join('')}</tr></thead><tbody>`;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        const row = tableCells(lines[i++]);
        html += `<tr>${head.map((_c, n) => cell('td', row[n] ?? '', n)).join('')}</tr>`;
      }
      out.push(`${html}</tbody></table>`);
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      flush();
      const ordered = /\d/.test(item[2]);
      const base = item[1].length;
      const items: string[][] = [];
      while (i < lines.length) {
        const m = LIST_ITEM.exec(lines[i]);
        if (m && m[1].length <= base + 1 && /\d/.test(m[2]) === ordered) { items.push([m[3]]); i++; continue; }
        if (!lines[i].trim()) {
          // a blank line ends the list unless the next line is more of it
          const next = lines[i + 1] ?? '';
          const nm = LIST_ITEM.exec(next);
          const more = nm ? nm[1].length > base + 1 || /\d/.test(nm[2]) === ordered : /^\s{2,}/.test(next);
          if (!next.trim() || !more) break;
          items[items.length - 1].push('');
          i++;
          continue;
        }
        // (an item of the other kind at this level starts another list)
        if (m && m[1].length <= base + 1) break;
        if (m || /^\s{2,}/.test(lines[i])) { items[items.length - 1].push(lines[i].replace(new RegExp(`^\\s{0,${base + 2 + (ordered ? 1 : 0)}}`), '')); i++; continue; }
        if (/^\s{0,3}(#{1,6}\s|>|```|~~~)/.test(lines[i])) break;
        items[items.length - 1].push(lines[i]);
        i++;
      }
      const start = ordered ? Number(/\d+/.exec(item[2])![0]) : 1;
      const tag = ordered ? 'ol' : 'ul';
      const body = items.map((it) => {
        const inner = it.length > 1 ? markdownToHtml(it.join('\n')) : inline(it[0]);
        // (a one-paragraph item reads as a line, not a block)
        return `<li>${it.length > 1 ? inner.replace(/^<p>([\s\S]*?)<\/p>/, '$1') : inner}</li>`;
      }).join('');
      out.push(`<${tag}${ordered && start !== 1 ? ` start="${start}"` : ''}>${body}</${tag}>`);
      continue;
    }
    if (/^( {4}|\t)/.test(line) && !para.length) {
      const body: string[] = [];
      while (i < lines.length && (/^( {4}|\t)/.test(lines[i]) || (!lines[i].trim() && /^( {4}|\t)/.test(lines[i + 1] ?? '')))) body.push(lines[i++].replace(/^( {4}|\t)/, ''));
      out.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }
    para.push(line);
    i++;
  }
  flush();
  return out.join('\n');
}

// ── Python, colored ──

const KEYWORDS = new Set(['and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield', 'match', 'case']);
const CONSTANTS = new Set(['True', 'False', 'None', 'self', 'cls']);
const BUILTINS = new Set(['print', 'len', 'range', 'int', 'float', 'str', 'list', 'dict', 'set', 'tuple', 'bool', 'open', 'input', 'type', 'isinstance', 'enumerate', 'zip', 'map', 'filter', 'sum', 'min', 'max', 'abs', 'sorted', 'reversed', 'any', 'all', 'round', 'super', 'object', 'Exception', 'ValueError', 'TypeError', 'KeyError', 'IndexError', 'display', 'repr', 'iter', 'next', 'hasattr', 'getattr', 'setattr', 'format', 'bytes', 'id', 'hash', 'dir', 'vars', 'help', 'ord', 'chr', 'divmod', 'pow']);

/** Classes: c comment, s string, n number, k keyword, o constant, b builtin, f a name being defined, d decorator, m magic or shell line */
export function highlightPython(source: string): string {
  let out = '';
  const span = (cls: string, text: string) => { out += `<span class="nb-${cls}">${escapeHtml(text)}</span>`; };
  let i = 0;
  let lineStart = true;
  let defined = false;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    if (ch === '\n') { out += '\n'; i++; lineStart = true; continue; }
    if (lineStart && (ch === ' ' || ch === '\t')) { out += ch; i++; continue; }
    if (lineStart && (ch === '%' || ch === '!')) {
      let end = source.indexOf('\n', i);
      if (end < 0) end = n;
      span('m', source.slice(i, end));
      i = end;
      continue;
    }
    if (lineStart && ch === '@') {
      const m = /^@[\w.]*/.exec(source.slice(i, i + 200))!;
      span('d', m[0]);
      i += m[0].length;
      lineStart = false;
      continue;
    }
    lineStart = false;
    if (ch === '#') {
      let end = source.indexOf('\n', i);
      if (end < 0) end = n;
      span('c', source.slice(i, end));
      i = end;
      continue;
    }
    const str = /^(?:[rbfuRBFU]{0,2})("""|'''|"|')/.exec(source.slice(i, i + 5));
    if (str && (ch === '"' || ch === "'" || /[A-Za-z_0-9]/.test(source[i - 1] ?? ' ') === false)) {
      const quote = str[1];
      let j = i + str[0].length;
      while (j < n) {
        if (source[j] === '\\') { j += 2; continue; }
        if (source.startsWith(quote, j)) { j += quote.length; break; }
        if (quote.length === 1 && source[j] === '\n') break;
        j++;
      }
      span('s', source.slice(i, Math.min(j, n)));
      i = Math.min(j, n);
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(source[i + 1] ?? ''))) {
      const m = /^(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*)?\.?\d[\d_]*(?:[eE][+-]?\d+)?[jJ]?)/.exec(source.slice(i, i + 80));
      if (m && m[0]) { span('n', m[0]); i += m[0].length; continue; }
    }
    if (/[A-Za-z_]|[^\x00-\x7f]/.test(ch)) {
      const m = /^(?:\w|[^\x00-\x7f])+/.exec(source.slice(i, i + 200))!;
      const word = m[0];
      if (defined) { span('f', word); defined = false; }
      else if (KEYWORDS.has(word)) { span('k', word); defined = word === 'def' || word === 'class'; }
      else if (CONSTANTS.has(word)) span('o', word);
      else if (BUILTINS.has(word) && source[i - 1] !== '.') span('b', word);
      else out += escapeHtml(word);
      i += word.length;
      continue;
    }
    out += escapeHtml(ch);
    i++;
  }
  return out;
}
