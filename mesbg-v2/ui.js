// ui.js — minimal DOM helpers shared by the builder and runner.

export const $ = (id) => document.getElementById(id);

// el('div.cls#id', { onclick, attrs... }, [children|string])
export function el(spec, props = {}, children = []) {
  // spec = "tag.class.class#id" — tag optional (defaults to div), e.g. ".row" or "#main".
  const tagMatch = spec.match(/^[a-zA-Z0-9-]+/);
  const tag = tagMatch ? tagMatch[0] : 'div';
  const attrs = tagMatch ? spec.slice(tag.length) : spec;
  const node = document.createElement(tag);
  for (const r of attrs.match(/[.#][^.#]+/g) || []) {
    if (r[0] === '.') node.classList.add(r.slice(1));
    else if (r[0] === '#') node.id = r.slice(1);
  }
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className += (node.className ? ' ' : '') + v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

// A top-right "✕" close button for a <dialog>. Place inside a position:relative body.
export function closeX(dlg) {
  return el('button.dialog-close-x', { type: 'button', title: 'Close', 'aria-label': 'Close', onclick: () => dlg.close() }, '✕');
}

// Minimal vector eye icon (inherits text colour via currentColor).
export function eyeIcon(size = 16) {
  return el('span.eye-icon', {
    html: `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 12S5 5 12 5s10.5 7 10.5 7-3.5 7-10.5 7S1.5 12 1.5 12Z"/><circle cx="12" cy="12" r="3"/></svg>`,
  });
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
