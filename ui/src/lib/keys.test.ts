import { describe, expect, it } from 'vitest';
import { isEditable, neighbour, resolveKey } from './keys.ts';

describe('resolveKey', () => {
  it('maps single keys', () => {
    expect(resolveKey({ key: 'n' }, null).action).toEqual({ kind: 'go', to: '/new' });
    expect(resolveKey({ key: '/' }, null).action).toEqual({ kind: 'search' });
    expect(resolveKey({ key: '?' }, null).action).toEqual({ kind: 'help' });
    expect(resolveKey({ key: 'j' }, null).action).toEqual({ kind: 'step', delta: 1 });
    expect(resolveKey({ key: 'k' }, null).action).toEqual({ kind: 'step', delta: -1 });
    expect(resolveKey({ key: '3' }, null).action).toEqual({ kind: 'tab', index: 2 });
    expect(resolveKey({ key: '0' }, null)).toEqual({ action: null, pending: null });
    expect(resolveKey({ key: 'x' }, null)).toEqual({ action: null, pending: null });
  });

  it('handles the g chord', () => {
    const first = resolveKey({ key: 'g' }, null);
    expect(first).toEqual({ action: null, pending: 'g' });
    expect(resolveKey({ key: 'r' }, first.pending).action).toEqual({ kind: 'go', to: '/' });
    expect(resolveKey({ key: 'n' }, 'g').action).toEqual({ kind: 'go', to: '/new' });
    // An unknown second key cancels the chord without firing the single-key binding.
    expect(resolveKey({ key: 'j' }, 'g')).toEqual({ action: null, pending: null });
  });

  it('ignores modified keys and keys typed into fields', () => {
    expect(resolveKey({ key: 'n', metaKey: true }, null).action).toBeNull();
    expect(resolveKey({ key: 'n', ctrlKey: true }, null).action).toBeNull();
    expect(resolveKey({ key: 'n', altKey: true }, null).action).toBeNull();
    expect(resolveKey({ key: 'n', editable: true }, null).action).toBeNull();
    expect(resolveKey({ key: 'r', editable: true }, 'g')).toEqual({ action: null, pending: null });
  });
});

describe('isEditable', () => {
  it('treats text fields as editable and toggles as not', () => {
    const el = (html: string) => {
      const d = document.createElement('div');
      d.innerHTML = html;
      return d.firstElementChild;
    };
    expect(isEditable(el('<input type="text">'))).toBe(true);
    expect(isEditable(el('<input type="search">'))).toBe(true);
    expect(isEditable(el('<textarea></textarea>'))).toBe(true);
    expect(isEditable(el('<select></select>'))).toBe(true);
    expect(isEditable(el('<input type="checkbox">'))).toBe(false);
    expect(isEditable(el('<button>x</button>'))).toBe(false);
    expect(isEditable(null)).toBe(false);
  });
});

describe('neighbour', () => {
  const ids = ['a', 'b', 'c'];
  it('steps within the roster and clamps at the ends', () => {
    expect(neighbour(ids, 'b', 1)).toBe('c');
    expect(neighbour(ids, 'b', -1)).toBe('a');
    expect(neighbour(ids, 'c', 1)).toBe('c');
    expect(neighbour(ids, 'a', -1)).toBe('a');
  });
  it('enters from outside the roster', () => {
    expect(neighbour(ids, null, 1)).toBe('a');
    expect(neighbour(ids, 'zzz', -1)).toBe('c');
    expect(neighbour([], null, 1)).toBeNull();
  });
});
