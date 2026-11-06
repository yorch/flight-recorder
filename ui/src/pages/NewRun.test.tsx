import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NewRun } from './NewRun.tsx';

describe('NewRun', () => {
  let sent: FormData | null;
  beforeEach(() => {
    sent = null;
    window.location.hash = '#/new';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/models') return new Response(JSON.stringify({ models: ['anthropic/claude-opus-5-5', 'stub'] }));
        if (url === '/api/secrets') return new Response(JSON.stringify({ secrets: ['TEST_USER_EMAIL', 'TEST_USER_PASSWORD'] }));
        sent = init?.body as FormData;
        return new Response(JSON.stringify({ run_id: '20261031-120000-abcd' }), { status: 201 });
      }),
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.location.hash = '';
  });

  it('keeps the e2e field contract and submits the multipart form', async () => {
    const v = render(<NewRun />);
    const q = <T extends Element>(sel: string) => v.container.querySelector(sel) as T;
    await waitFor(() => expect(q<HTMLSelectElement>('#f-model').value).toBe('stub'));
    expect(q('#f-model option[value="stub"]')).not.toBeNull();
    fireEvent.change(q('#f-title'), { target: { value: 'UI e2e blog' } });
    fireEvent.change(q('#f-instructions'), { target: { value: 'post a blog' } });
    fireEvent.change(q('#f-start'), { target: { value: 'http://app.test/admin/login' } });
    fireEvent.change(q('#f-hosts'), { target: { value: 'app.test:80' } });
    fireEvent.change(q('#f-stub'), { target: { value: '{"turns":[]}' } });
    const typeBox = q<HTMLInputElement>('[data-cred="TEST_USER_EMAIL:email"]');
    expect(typeBox.disabled).toBe(true);
    fireEvent.click(q('[data-cred="TEST_USER_EMAIL"]'));
    // Enabled credential with no input type blocks submit.
    expect(q<HTMLButtonElement>('button[type="submit"]').disabled).toBe(true);
    fireEvent.click(typeBox);
    fireEvent.click(q('#f-review'));
    expect(v.getByText('manual approval')).toBeTruthy();
    expect(v.getByText('http://app.test')).toBeTruthy();
    expect(v.container.querySelectorAll('button[type="submit"]')).toHaveLength(1);
    await act(async () => fireEvent.keyDown(q('#f-instructions'), { key: 'Enter', metaKey: true }));
    await waitFor(() => expect(window.location.hash).toBe('#/run/20261031-120000-abcd'));
    const fd = sent as unknown as FormData;
    expect(fd.get('title')).toBe('UI e2e blog');
    expect(fd.get('model')).toBe('stub');
    expect(fd.get('allowed_hosts')).toBe('app.test:80');
    expect(fd.get('review_plan')).toBe('true');
    expect(fd.get('network')).toBe('limited');
    expect(JSON.parse(String(fd.get('credentials')))).toEqual([{ name: 'TEST_USER_EMAIL', input_types: ['email'] }]);
    expect(fd.get('stub_script')).toBe('{"turns":[]}');
  });

  it('rejects an invalid stub script before posting', async () => {
    const v = render(<NewRun />);
    const q = <T extends Element>(sel: string) => v.container.querySelector(sel) as T;
    await waitFor(() => expect(q<HTMLSelectElement>('#f-model').value).toBe('stub'));
    fireEvent.change(q('#f-instructions'), { target: { value: 'x' } });
    fireEvent.change(q('#f-stub'), { target: { value: '{nope' } });
    fireEvent.submit(q('form'));
    expect(v.getByRole('alert').textContent).toBe('Stub script must be valid JSON.');
    expect(sent).toBeNull();
  });
});
