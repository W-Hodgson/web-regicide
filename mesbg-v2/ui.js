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

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
