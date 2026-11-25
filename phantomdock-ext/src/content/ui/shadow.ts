// Closed Shadow DOM root portal with randomized neutral host attributes.
// Nothing in the light DOM mentions phantomdock/pdock/chrome-extension — the
// host element is a bare <div data-u-xxxxxx="1">.

const STYLE = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: -apple-system, system-ui, 'Segoe UI', Roboto, sans-serif; }

  .pd-theme {
    --bg: #ffffff;
    --bg-elev: #f6f7f9;
    --fg: #16181d;
    --fg-dim: #5c6470;
    --border: #d8dde3;
    --accent: #0e7490;
    --accent-fg: #ffffff;
    --ok: #15803d;
    --warn: #b45309;
    --err: #b91c1c;
    --chip: #eef1f4;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    .pd-theme {
      --bg: #14181d;
      --bg-elev: #1d2228;
      --fg: #e8eaee;
      --fg-dim: #9aa3af;
      --border: #333a42;
      --accent: #22d3ee;
      --accent-fg: #06232b;
      --ok: #4ade80;
      --warn: #fbbf24;
      --err: #f87171;
      --chip: #262c33;
    }
  }

  .panel {
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: 0 8px 28px rgba(0,0,0,.22);
  }
  .row { display: flex; align-items: center; gap: 8px; }
  .grow { flex: 1 1 auto; }
  .dim { color: var(--fg-dim); font-size: 12px; }
  .mono { font-family: var(--mono); }
  .btn {
    appearance: none; border: 1px solid var(--border); background: var(--bg-elev);
    color: var(--fg); border-radius: 7px; padding: 5px 10px; font-size: 12px;
    cursor: pointer; line-height: 1.2; white-space: nowrap;
  }
  .dock-controls {
    position: relative; display: flex; flex-wrap: wrap; gap: 6px;
    align-items: center; padding: 7px; pointer-events: auto;
    max-width: calc(100vw - 36px);
  }
  .skill-menu {
    position: absolute; bottom: calc(100% + 8px); right: 0; padding: 9px;
    width: min(320px, calc(100vw - 36px)); box-sizing: border-box;
  }
  .skill-search {
    width: 100%; box-sizing: border-box; padding: 7px 9px; margin-bottom: 6px;
    background: var(--bg-elev); color: var(--fg);
    border: 1px solid var(--border); border-radius: 6px;
  }
  .skill-results { max-height: min(210px, 40vh); overflow: auto; }
  .btn:focus-visible, .skill-search:focus-visible {
    outline: 2px solid var(--accent); outline-offset: 1px;
  }
  .btn:hover { border-color: var(--accent); }
  .btn.primary { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); font-weight: 600; }
  .btn.danger { background: var(--err); color: #fff; border-color: var(--err); font-weight: 600; }
  .btn.ghost { background: transparent; border-color: transparent; }
  .btn.ghost:hover { border-color: var(--border); }
  .btn:disabled { opacity: .45; cursor: default; }
  .badge {
    display: inline-block; font-size: 10px; font-weight: 700; letter-spacing: .04em;
    padding: 2px 6px; border-radius: 5px; background: var(--chip); color: var(--fg-dim);
    text-transform: uppercase;
  }
  .badge.fs { color: var(--accent); }
  .badge.skill { color: var(--ok); }
  .badge.mcp { color: var(--warn); }
  .badge.shell { color: var(--err); }
  .status-ok { color: var(--ok); }
  .status-err { color: var(--err); }
  .status-warn { color: var(--warn); }
  .dot {
    width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
    background: var(--fg-dim);
  }
  .dot.on { background: var(--ok); }
  .dot.off { background: var(--err); }
  .dot.warn { background: var(--warn); }
  pre.code {
    margin: 6px 0 0; padding: 8px; border-radius: 7px; background: var(--bg-elev);
    border: 1px solid var(--border); font-family: var(--mono); font-size: 11px;
    white-space: pre-wrap; word-break: break-word; max-height: 220px; overflow: auto;
    color: var(--fg);
  }
  .diff-add { color: var(--ok); }
  .diff-del { color: var(--err); }
  .toast {
    padding: 6px 10px; border-radius: 8px; font-size: 11px;
    background: var(--bg-elev); border: 1px solid var(--border); color: var(--fg);
    box-shadow: 0 4px 16px rgba(0,0,0,.18); max-width: 420px;
  }
  .toast.err { border-color: var(--err); color: var(--err); }
  .toast.ok { border-color: var(--ok); color: var(--ok); }
`;

export interface ShadowRootHandle {
  host: HTMLDivElement;
  root: ShadowRoot;
  stage: HTMLDivElement; // layer for viewport-anchored pills
  dock: HTMLDivElement; // fixed bottom-right stack for ToolCards (zero overlap)
  float: HTMLDivElement; // layer for the fixed control bar
}

let cached: ShadowRootHandle | null = null;

export function getShadowRoot(): ShadowRootHandle {
  if (cached && cached.host.isConnected) return cached;
  const host = document.createElement('div');
  // Randomized, neutral, session-scoped attribute — zero fingerprint strings.
  const attr = `u-${Math.random().toString(36).slice(2, 8)}`;
  host.setAttribute(`data-${attr}`, '1');
  host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483646;';
  const root = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = STYLE;
  root.appendChild(style);

  const theme = document.createElement('div');
  theme.className = 'pd-theme';
  root.appendChild(theme);

  const stage = document.createElement('div');
  stage.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;';

  const dock = document.createElement('div');
  dock.style.cssText =
    'position:fixed;bottom:70px;right:18px;width:430px;max-width:calc(100vw - 36px);max-height:68vh;overflow-y:auto;display:flex;flex-direction:column;gap:8px;pointer-events:none;';

  const float = document.createElement('div');
  float.style.cssText =
    'position:fixed;bottom:18px;right:18px;display:flex;flex-direction:column;align-items:flex-end;gap:6px;pointer-events:none;';

  theme.append(stage, dock, float);

  document.documentElement.appendChild(host);
  cached = { host, root, stage, dock, float };
  return cached;
}

/** Tiny hyperscript helper for imperative Shadow DOM components. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean | null | undefined | ((e: Event) => void)> = {},
  children: (Node | string | null | undefined)[] = [],
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'style' && typeof v === 'string') el.style.cssText = v;
    else if (k === 'text') el.textContent = String(v);
    else if (k === 'class') el.className = String(v);
    else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2), v as EventListener);
    } else el.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined) continue;
    el.append(c);
  }
  return el;
}

/**
 * Anchor a shadow element over a page element (rect-based, rAF-throttled).
 * Automatically hides the overlay when the target is disconnected, collapsed,
 * or scrolled completely outside the viewport.
 */
export function anchorOver(
  shadowEl: HTMLElement,
  target: HTMLElement,
  placement: 'below' | 'cover' = 'below',
): () => void {
  let raf = 0;
  const place = (): void => {
    if (!target.isConnected) {
      shadowEl.style.display = 'none';
      return;
    }
    const r = target.getBoundingClientRect();
    const outOfView =
      (r.width === 0 && r.height === 0) ||
      r.bottom < 0 ||
      r.top > window.innerHeight ||
      r.right < 0 ||
      r.left > window.innerWidth;
    if (outOfView) {
      shadowEl.style.display = 'none';
      return;
    }
    shadowEl.style.display = 'flex';
    shadowEl.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 360))}px`;
    if (placement === 'cover') {
      shadowEl.style.top = `${Math.max(8, r.top)}px`;
    } else {
      const below = r.bottom + 6;
      const top = below + 240 > window.innerHeight ? Math.max(8, r.top - 246) : below;
      shadowEl.style.top = `${top}px`;
    }
  };
  const schedule = (): void => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      place();
    });
  };
  place();
  window.addEventListener('scroll', schedule, { capture: true, passive: true });
  window.addEventListener('resize', schedule, { passive: true });
  return () => {
    if (raf) cancelAnimationFrame(raf);
    window.removeEventListener('scroll', schedule, { capture: true } as EventListenerOptions);
    window.removeEventListener('resize', schedule);
  };
}
