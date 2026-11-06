// Keyboard-first console: a pure resolver from key presses to actions so the
// bindings are unit-testable. `g` starts a two-key chord (`g r`, `g n`).

export type KeyAction =
  | { kind: 'go'; to: string }
  | { kind: 'search' }
  | { kind: 'tab'; index: number }
  | { kind: 'step'; delta: 1 | -1 }
  | { kind: 'help' };

export interface KeyInput {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  /** True when focus is in a text field, select or contenteditable. */
  editable?: boolean;
}

export interface KeyResult {
  action: KeyAction | null;
  pending: string | null;
}

export const SHORTCUTS: { keys: string; what: string }[] = [
  { keys: 'g r', what: 'Go to the runs board' },
  { keys: 'n', what: 'New run' },
  { keys: 'j / k', what: 'Next / previous run in the rail' },
  { keys: '1 – 5', what: 'Switch run detail panel' },
  { keys: '/', what: 'Focus the search field' },
  { keys: '← →', what: 'Browse screenshots in the viewer' },
  { keys: '?', what: 'Show this help' },
];

const NONE: KeyResult = { action: null, pending: null };

export function resolveKey(e: KeyInput, pending: string | null): KeyResult {
  if (e.ctrlKey || e.metaKey || e.altKey || e.editable) return NONE;
  if (pending === 'g') {
    if (e.key === 'r') return { action: { kind: 'go', to: '/' }, pending: null };
    if (e.key === 'n') return { action: { kind: 'go', to: '/new' }, pending: null };
    return NONE;
  }
  switch (e.key) {
    case 'g':
      return { action: null, pending: 'g' };
    case 'n':
      return { action: { kind: 'go', to: '/new' }, pending: null };
    case '/':
      return { action: { kind: 'search' }, pending: null };
    case '?':
      return { action: { kind: 'help' }, pending: null };
    case 'j':
      return { action: { kind: 'step', delta: 1 }, pending: null };
    case 'k':
      return { action: { kind: 'step', delta: -1 }, pending: null };
    default:
      if (/^[1-9]$/.test(e.key)) return { action: { kind: 'tab', index: Number(e.key) - 1 }, pending: null };
      return NONE;
  }
}

export function isEditable(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  if (t instanceof HTMLInputElement) return !['checkbox', 'radio', 'button', 'submit', 'reset', 'file'].includes(t.type);
  return t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;
}

/** Neighbouring run id in roster order; from outside the roster j enters at the top, k at the bottom. */
export function neighbour(ids: readonly string[], current: string | null, delta: 1 | -1): string | null {
  if (ids.length === 0) return null;
  const i = current === null ? -1 : ids.indexOf(current);
  if (i < 0) return delta === 1 ? (ids[0] ?? null) : (ids.at(-1) ?? null);
  return ids[Math.min(ids.length - 1, Math.max(0, i + delta))] ?? null;
}
