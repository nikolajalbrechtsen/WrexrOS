// Minimal keyed virtual-DOM renderer with signal-based reactive re-rendering.
// No JSX, no dependencies, no innerHTML except for explicitly trusted raw SVG.

export type Child = VNode | string | number | boolean | null | undefined | Child[];
export type Props = Record<string, any>;

export interface VNode {
  tag: string | symbol | Function;
  props: Props;
  children: VNode[];
  key?: string | number;
  dom?: Node;
  text?: string;
  managed?: Node[];
  listeners?: Record<string, EventListener>;
}

export const Fragment = Symbol('Fragment');

const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set([
  'svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon',
  'defs', 'linearGradient', 'radialGradient', 'stop', 'text', 'tspan', 'use',
  'symbol', 'clipPath', 'mask', 'filter', 'feGaussianBlur', 'title', 'desc'
]);

const EVENT_PROP = /^on[A-Z]/;

function isVNode(value: any): value is VNode {
  return value && typeof value === 'object' && 'tag' in value && 'props' in value && 'children' in value;
}

function appendChild(out: VNode[], child: Child): void {
  if (child === null || child === undefined || typeof child === 'boolean') return;
  if (Array.isArray(child)) { for (const item of child) appendChild(out, item); return; }
  if (typeof child === 'string' || typeof child === 'number') {
    out.push({ tag: '#text', props: {}, children: [], text: String(child) });
    return;
  }
  if (isVNode(child)) { out.push(child); return; }
  out.push({ tag: '#text', props: {}, children: [], text: String(child) });
}

export function h(tag: string | symbol | Function, props?: Props | null, ...children: Child[]): VNode {
  if (typeof tag === 'function' && tag !== Fragment) {
    return tag({ ...(props || {}), children }, ...children) as VNode;
  }
  const p: Props = props || {};
  const normalized: VNode[] = [];
  for (const child of children) appendChild(normalized, child);
  if (p.children !== undefined) appendChild(normalized, p.children as Child);
  return {
    tag,
    props: p,
    children: normalized,
    key: p.key === undefined ? undefined : p.key
  };
}

// Trusted SVG/HTML string. Only use with static markup or numeric chart geometry.
export function rawSvg(html: string, isSvg = false): VNode {
  return { tag: '#raw', props: { html, svg: isSvg }, children: [] };
}

function sameType(a: VNode, b: VNode): boolean {
  return a.tag === b.tag && a.key === b.key && a.text === b.text;
}

function classString(value: any): string {
  if (!value) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(classString).filter(Boolean).join(' ');
  if (typeof value === 'object') {
    return Object.keys(value).filter((k) => !!value[k]).join(' ');
  }
  return '';
}

function styleString(value: any): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    return Object.keys(value)
      .filter((k) => value[k] !== null && value[k] !== undefined && value[k] !== false)
      .map((k) => {
        const name = k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
        return `${name}:${String(value[k]).replace(/;$/, '')}`;
      })
      .join(';');
  }
  return '';
}

function eventName(prop: string): string {
  const name = prop.slice(2);
  if (name === 'DoubleClick') return 'dblclick';
  if (name === 'ContextMenu') return 'contextmenu';
  return name.charAt(0).toLowerCase() + name.slice(1);
}

function setAttribute(el: Element, name: string, value: any): void {
  if (value === null || value === undefined || value === false) { el.removeAttribute(name); return; }
  if (value === true) { el.setAttribute(name, ''); return; }
  el.setAttribute(name, String(value));
}

function applyProps(el: Element, vnode: VNode, oldProps: Props | null): void {
  const props = vnode.props;
  const listeners: Record<string, EventListener> = {};
  const oldListeners = vnode.listeners || {};

  for (const name of Object.keys(oldListeners)) {
    if (!props[name] || !EVENT_PROP.test(name)) {
      el.removeEventListener(eventName(name), oldListeners[name]);
    }
  }

  const nextClass = classString(props.class || props.className);
  const prevClass = oldProps ? classString(oldProps.class || oldProps.className) : '';
  if (nextClass !== prevClass) setAttribute(el, 'class', nextClass);

  const nextStyle = styleString(props.style);
  const prevStyle = oldProps ? styleString(oldProps.style) : '';
  if (nextStyle !== prevStyle) setAttribute(el, 'style', nextStyle);

  for (const name of Object.keys(props)) {
    if (name === 'key' || name === 'children' || name === 'class' || name === 'className' ||
        name === 'style' || name === 'key' || name === 'ref' || name === 'html' || name === 'svg') continue;
    if (EVENT_PROP.test(name)) {
      const fn = props[name];
      const oldFn = oldProps ? oldProps[name] : undefined;
      if (typeof fn === 'function') {
        if (oldFn !== fn) {
          if (typeof oldFn === 'function' && oldListeners[name]) el.removeEventListener(eventName(name), oldListeners[name]);
          const listener = fn as EventListener;
          el.addEventListener(eventName(name), listener);
          listeners[name] = listener;
        } else if (oldListeners[name]) {
          listeners[name] = oldListeners[name];
        }
      }
      continue;
    }
    if (name === 'value' || name === 'checked' || name === 'selected' || name === 'indeterminate') continue;
    const value = props[name];
    const old = oldProps ? oldProps[name] : undefined;
    if (value !== old) setAttribute(el, name, value);
  }

  vnode.listeners = listeners;

  const ref = props.ref;
  if (typeof ref === 'function' && ref !== (oldProps && oldProps.ref)) ref(el);
  else if (ref && typeof ref === 'object' && ref.current !== el) ref.current = el;

  // DOM properties are applied after children so <select> options exist.
  for (const name of ['value', 'checked', 'selected', 'indeterminate']) {
    if (!(name in props)) continue;
    const target = el as any;
    const value = props[name];
    if (target[name] !== value) {
      try { target[name] = value; } catch { /* read-only property */ }
    }
  }
}

function insertBefore(parent: Node, node: Node, before: Node | null): void {
  if (node === before) return;
  parent.insertBefore(node, before || null);
}

// Fragments own a comment anchor plus a list of managed sibling nodes.
// They must be inserted together or later patches see children without DOM.
function insertVNode(parent: Node, vnode: VNode, before: Node | null): Node {
  if (vnode.tag !== Fragment) {
    const dom = createDom(vnode);
    insertBefore(parent, dom, before);
    return dom;
  }
  vnode.dom = document.createComment('fragment');
  vnode.managed = [];
  insertBefore(parent, vnode.dom, before);
  const managed = reconcile(parent, [], vnode.children, before);
  vnode.managed = managed.map((child) => child.dom).filter(Boolean) as Node[];
  return vnode.dom;
}

function moveVNode(parent: Node, vnode: VNode, before: Node | null): void {
  if (!vnode.dom || vnode.dom.parentNode !== parent) return;
  if (vnode.tag !== Fragment) {
    insertBefore(parent, vnode.dom, before);
    return;
  }
  const managed = vnode.managed || [];
  // `before` can be the first node after this fragment; moving into its own
  // siblings would break their relative order.
  if (before && managed.indexOf(before) >= 0) return;
  for (const node of [vnode.dom, ...managed]) {
    if (node.parentNode === parent) insertBefore(parent, node, before);
  }
}

function createDom(vnode: VNode): Node {
  if (vnode.tag === '#text') {
    vnode.dom = document.createTextNode(vnode.text || '');
    return vnode.dom;
  }
  if (vnode.tag === '#raw') {
    const holder = vnode.props.svg
      ? document.createElementNS(SVG_NS, 'g')
      : document.createElement('span');
    holder.innerHTML = String(vnode.props.html || '');
    vnode.dom = holder;
    return holder;
  }
  if (vnode.tag === Fragment) {
    vnode.dom = document.createComment('fragment');
    vnode.managed = [];
    return vnode.dom;
  }
  if (typeof vnode.tag === 'function') {
    const produced = (vnode.tag as Function)(vnode.props, ...vnode.children) as VNode;
    return createDom(produced);
  }
  const tag = vnode.tag as string;
  const isSvg = SVG_TAGS.has(tag) || !!vnode.props.__svg;
  const el = isSvg ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
  vnode.dom = el;
  if (vnode.children.length) reconcile(el, [], vnode.children, null);
  applyProps(el, vnode, null);
  return el;
}

function fragmentBefore(vnode: VNode): Node | null {
  const managed = new Set(vnode.managed || []);
  let node = vnode.dom ? vnode.dom.nextSibling : null;
  while (node && managed.has(node)) node = node.nextSibling;
  return node;
}

function removeDom(vnode: VNode): void {
  if (vnode.tag === Fragment) {
    for (const child of vnode.children) removeDom(child);
    if (vnode.dom && vnode.dom.parentNode) vnode.dom.parentNode.removeChild(vnode.dom);
    return;
  }
  if (vnode.listeners && vnode.dom) {
    for (const name of Object.keys(vnode.listeners)) {
      vnode.dom.removeEventListener(eventName(name), vnode.listeners[name]);
    }
  }
  if (typeof vnode.props.ref === 'function') {
    try { vnode.props.ref(null); } catch { /* ignore */ }
  }
  if (vnode.dom && vnode.dom.parentNode) vnode.dom.parentNode.removeChild(vnode.dom);
}

function patch(old: VNode, next: VNode): Node {
  if (!sameType(old, next)) {
    const parent = old.dom && old.dom.parentNode;
    const before = old.dom ? old.dom.nextSibling : null;
    const fresh = parent ? insertVNode(parent, next, before) : createDom(next);
    if (parent && old.dom && old.dom.parentNode === parent) parent.removeChild(old.dom);
    removeDom(old);
    return fresh;
  }

  if (next.tag === '#text') {
    const dom = old.dom as Text;
    if (dom.textContent !== (next.text || '')) dom.textContent = next.text || '';
    next.dom = dom;
    return dom;
  }

  if (next.tag === '#raw') {
    const html = String(next.props.html || '');
    if (old.props.html !== html && old.dom) (old.dom as Element).innerHTML = html;
    next.dom = old.dom;
    next.listeners = old.listeners;
    return old.dom as Node;
  }

  const dom = old.dom as Element;
  const tag = next.tag as string;
  next.dom = dom;

  if (next.tag === Fragment) {
    const before = fragmentBefore(old);
    const parent = dom.parentNode;
    if (parent) {
      const managed = reconcile(parent, old.children, next.children, before);
      next.managed = managed.map((v) => v.dom).filter(Boolean) as Node[];
    }
    next.listeners = old.listeners;
    return dom;
  }

  applyProps(dom, next, old.props);
  if (next.children.length || old.children.length) {
    reconcile(dom, old.children, next.children, null);
  }
  if (tag === 'select' && 'value' in next.props) {
    const select = dom as HTMLSelectElement;
    if (select.value !== String(next.props.value)) select.value = String(next.props.value);
  }
  return dom;
}

function reconcile(parent: Node, oldChildren: VNode[], newChildren: VNode[], before: Node | null): VNode[] {
  const oldByKey = new Map<string | number, VNode>();
  const used = new Set<VNode>();
  for (const old of oldChildren) if (old.key !== undefined) oldByKey.set(old.key, old);

  let cursor = 0;
  const result: VNode[] = [];

  for (const next of newChildren) {
    let match: VNode | undefined;
    if (next.key !== undefined) {
      const candidate = oldByKey.get(next.key);
      if (candidate && !used.has(candidate) && sameType(candidate, next)) match = candidate;
    } else {
      while (cursor < oldChildren.length &&
             (used.has(oldChildren[cursor]) || oldChildren[cursor].key !== undefined)) cursor++;
      const candidate = oldChildren[cursor];
      if (candidate && sameType(candidate, next)) { match = candidate; cursor++; }
    }

    if (match) {
      patch(match, next);
      moveVNode(parent, match, before);
      used.add(match);
    } else {
      insertVNode(parent, next, before);
    }
    result.push(next);
  }

  for (const old of oldChildren) if (!used.has(old)) removeDom(old);
  return result;
}

const roots = new WeakMap<Element, VNode>();

export function mount(el: Element, vnode: VNode): VNode {
  const old = roots.get(el);
  const previous = old ? [old] : [];
  const result = reconcile(el, previous, [vnode], null);
  roots.set(el, result[0]);
  return result[0];
}

let scheduler: (() => void) | null = null;
let queued = false;

export function setScheduler(fn: () => void): void {
  scheduler = fn;
}

export function scheduleRender(): void {
  if (queued) return;
  queued = true;
  queueMicrotask(() => { queued = false; if (scheduler) scheduler(); });
}

export interface Store<T> {
  readonly value: T;
  get(): T;
  set(next: T | ((prev: T) => T)): void;
  subscribe(fn: (value: T) => void): () => void;
}

export function useState<T>(initial: T): Store<T> {
  let value = initial;
  const subscribers = new Set<(value: T) => void>();
  return {
    get value() { return value; },
    get() { return value; },
    set(next: T | ((prev: T) => T)): void {
      const resolved = typeof next === 'function' ? (next as any)(value) as T : next;
      if (Object.is(resolved, value)) return;
      value = resolved;
      for (const fn of subscribers) fn(value);
      scheduleRender();
    },
    subscribe(fn: (value: T) => void): () => void {
      subscribers.add(fn);
      return () => { subscribers.delete(fn); };
    }
  };
}
