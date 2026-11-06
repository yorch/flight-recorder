import { describe, expect, it } from 'vitest';
import { tabOf, withTab } from './tabs.ts';

describe('run tabs', () => {
  it('parses the tab param with an overview default', () => {
    expect(tabOf(null)).toBe('overview');
    expect(tabOf('network')).toBe('network');
    expect(tabOf('nope')).toBe('overview');
  });
  it('writes the tab, omitting the default, and keeps other params', () => {
    const p = new URLSearchParams('net.sort=ms:desc');
    expect(withTab(p, 'network').toString()).toBe('net.sort=ms%3Adesc&tab=network');
    expect(withTab(new URLSearchParams('tab=network&q=x'), 'overview').toString()).toBe('q=x');
    expect(p.toString()).toBe('net.sort=ms%3Adesc');
  });
});
