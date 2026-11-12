/**
 * Replica del cheerio limitado que Nuvio TV expone a los plugins JS.
 *
 * En QuickJS (PluginRuntime.kt) el global `cheerio` NO es la libreria real:
 * es un shim respaldado por jsoup que solo expone un subconjunto de metodos
 * (load, find, each, text, html, attr, first, last, eq, get, children, filter,
 * next, prev, toArray). Metodos como map/parent/closest/data/prop/is/remove
 * NO existen -> en el dispositivo rompen el plugin; en Node con cheerio real
 * pasarian inadvertidos.
 *
 * Este wrapper reproduce ese subconjunto sobre cheerio real para que el
 * harness falle en el PC igual que falla en la TV.
 */

import * as cheerioNS from "cheerio";

const cheerio = cheerioNS.default ?? cheerioNS;

export function makeCheerio() {
  function wrap(nodes, root) {
    const w = {
      _nodes: nodes,
      get length() { return nodes.length; },
      each(cb) {
        nodes.forEach((n, i) => {
          const el = wrap([n], root);
          cb.call(el, i, el);
        });
        return w;
      },
      find(sel) {
        const out = [];
        nodes.forEach((n) => out.push(...root(n).find(sel).toArray()));
        return wrap(out, root);
      },
      text() {
        return nodes.map((n) => root(n).text()).join(" ");
      },
      html() {
        return nodes.length ? root(nodes[0]).html() : "";
      },
      attr(name) {
        if (!nodes.length) return undefined;
        const v = root(nodes[0]).attr(name);
        return v === undefined ? undefined : v;
      },
      first() { return wrap(nodes.slice(0, 1), root); },
      last() { return wrap(nodes.slice(-1), root); },
      eq(i) { return wrap(nodes[i] !== undefined ? [nodes[i]] : [], root); },
      get(i) {
        if (i === undefined) return wrap(nodes.slice(), root);
        return wrap(nodes[i] !== undefined ? [nodes[i]] : [], root);
      },
      children(sel) {
        const out = [];
        nodes.forEach((n) => out.push(...root(n).find(sel || "*").toArray()));
        return wrap(out, root);
      },
      filter(selOrCb) {
        if (typeof selOrCb !== "function") return w; // el shim ignora selectores
        const out = [];
        nodes.forEach((n, i) => {
          const el = wrap([n], root);
          if (selOrCb.call(el, i, el)) out.push(n);
        });
        return wrap(out, root);
      },
      next() {
        const out = [];
        nodes.forEach((n) => { const s = root(n).next(); if (s && s.length) out.push(...s.toArray()); });
        return wrap(out, root);
      },
      prev() {
        const out = [];
        nodes.forEach((n) => { const s = root(n).prev(); if (s && s.length) out.push(...s.toArray()); });
        return wrap(out, root);
      },
      toArray() { return nodes.map((n) => wrap([n], root)); }
    };
    return w;
  }

  return {
    load(html) {
      const root = cheerio.load(html);
      const $ = (selector, context) => {
        if (selector && selector._nodes) return selector;
        if (context && context._nodes && context.length) {
          const out = [];
          context._nodes.forEach((n) => out.push(...root(n).find(selector).toArray()));
          return wrap(out, root);
        }
        if (typeof selector === "string") return wrap(root(selector).toArray(), root);
        return wrap([], root);
      };
      $.html = (el) => {
        if (el && el._nodes && el.length) return el._nodes[0].html();
        return root.html();
      };
      return $;
    }
  };
}
