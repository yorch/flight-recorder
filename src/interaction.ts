import { errors, type Locator, type Page } from 'playwright-core';
import type { Cursor } from './cursor.ts';
import type { ActionKind, ActionMode, EventLog, Point, Size, Status } from './events.ts';
import { clampToScreen } from './geometry.ts';
import { redact } from './secrets.ts';
import type { Session } from './session.ts';

export class AssertionFailure extends Error {}

/**
 * `page.goto` resolves on any HTTP response, so an error page (including Squid's own
 * DNS-failure / denied pages, marked with `X-Squid-Error`) would otherwise count as a
 * successful navigation. Returns the failure message, or null when the response is OK.
 */
export function navigationError(url: string, status: number | null, headers: Record<string, string> = {}): string | null {
  if (status === null || status < 400) return null;
  const proxy = headers['x-squid-error'];
  return `Navigation to ${url} returned HTTP ${status}${proxy ? ` (proxy error: ${proxy})` : ''}`;
}

type StepMeta = { step_id: string; label: string; action: ActionKind; mode: ActionMode; plan_step?: string | null };
type AriaRole = Parameters<Page['getByRole']>[0];

export class InteractionEngine {
  private readonly session: Session;
  private readonly cursor: Cursor;
  private readonly log: EventLog;
  private readonly screen: Size;
  private readonly isAllowedUrl: (url: string) => boolean;

  constructor(deps: { session: Session; cursor: Cursor; log: EventLog; screen: Size; isAllowedUrl: (url: string) => boolean }) {
    this.session = deps.session;
    this.cursor = deps.cursor;
    this.log = deps.log;
    this.screen = deps.screen;
    this.isAllowedUrl = deps.isAllowedUrl;
  }

  private get page(): Page {
    return this.session.page;
  }

  private async step(meta: StepMeta, fn: () => Promise<void>): Promise<void> {
    this.log.emit({ type: 'ACTION_START', ...meta });
    try {
      await fn();
      this.log.emit({ type: 'ACTION_END', step_id: meta.step_id, status: 'PASSED' });
    } catch (err) {
      this.log.emit({
        type: 'ACTION_END',
        step_id: meta.step_id,
        status: 'FAILED',
        error: redact(err instanceof Error ? err.message : String(err)),
      });
      throw err;
    }
  }

  /** Scrolls the element into view, logs its on-screen box, and optionally glides the cursor to it. */
  private async target(stepId: string, el: Locator, glide: boolean): Promise<void> {
    await el.scrollIntoViewIfNeeded();
    const box = await el.boundingBox();
    if (!box) throw new Error('Element has no bounding box (not visible)');
    const point = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
    this.log.emit({ type: 'ACTION_TARGET', step_id: stepId, point, box });
    if (glide) await this.cursor.glideTo(point);
  }

  private async pointAt(stepId: string, raw: Point): Promise<Point> {
    const point = clampToScreen(raw, this.screen);
    this.log.emit({ type: 'ACTION_TARGET', step_id: stepId, point });
    await this.cursor.glideTo(point);
    return point;
  }

  private async visible(el: Locator, what: string, timeoutMs: number): Promise<void> {
    try {
      await el.waitFor({ state: 'visible', timeout: timeoutMs });
    } catch (err) {
      if (err instanceof errors.TimeoutError) throw new AssertionFailure(`Expected ${what} to be visible`);
      throw err;
    }
  }

  navigate(stepId: string, label: string, url: string, planStep?: string | null) {
    return this.step({ step_id: stepId, label, action: 'navigate', mode: 'PAGE', plan_step: planStep ?? null }, async () => {
      if (!this.isAllowedUrl(url)) throw new Error(`URL not in allowlist: ${url}`);
      const res = await this.page.goto(url, { waitUntil: 'load' });
      const err = res && navigationError(url, res.status(), res.headers());
      if (err) throw new Error(err);
    });
  }

  click(stepId: string, label: string, ref: string, planStep?: string | null) {
    return this.step({ step_id: stepId, label, action: 'click', mode: 'ELEMENT', plan_step: planStep ?? null }, async () => {
      const el = this.page.getByRef(ref);
      await this.target(stepId, el, true);
      await el.click();
    });
  }

  clickAt(stepId: string, label: string, screenPoint: Point, planStep?: string | null) {
    return this.step({ step_id: stepId, label, action: 'click', mode: 'COORDINATE', plan_step: planStep ?? null }, async () => {
      const p = await this.pointAt(stepId, screenPoint);
      await this.page.mouse.click(p.x, p.y);
    });
  }

  /** `text` may contain secret placeholders; `resolve` turns it into the final value inside the step. */
  type(
    stepId: string,
    label: string,
    ref: string,
    text: string,
    mode: 'replace' | 'append',
    resolve?: (el: Locator) => Promise<string>,
    planStep?: string | null,
  ) {
    return this.step({ step_id: stepId, label, action: 'type', mode: 'ELEMENT', plan_step: planStep ?? null }, async () => {
      const el = this.page.getByRef(ref);
      const value = resolve ? await resolve(el) : text;
      await this.target(stepId, el, true);
      await el.click();
      if (mode === 'replace') await el.fill('');
      else await el.press('End');
      await el.pressSequentially(value, { delay: 40 });
    });
  }

  press(stepId: string, label: string, key: string, planStep?: string | null) {
    return this.step({ step_id: stepId, label, action: 'press', mode: 'PAGE', plan_step: planStep ?? null }, () =>
      this.page.keyboard.press(key),
    );
  }

  scroll(stepId: string, label: string, screenPoint: Point, dy: number, planStep?: string | null) {
    return this.step({ step_id: stepId, label, action: 'scroll', mode: 'COORDINATE', plan_step: planStep ?? null }, async () => {
      const p = await this.pointAt(stepId, screenPoint);
      await this.page.mouse.move(p.x, p.y);
      await this.page.mouse.wheel(0, dy);
    });
  }

  respondToDialog(stepId: string, label: string, accept: boolean, promptText?: string, planStep?: string | null) {
    return this.step({ step_id: stepId, label, action: 'dialog', mode: 'PAGE', plan_step: planStep ?? null }, async () => {
      const dialog = this.session.dialog;
      if (!dialog) throw new Error('No dialog is open');
      this.session.dialog = null;
      if (accept) await dialog.accept(promptText);
      else await dialog.dismiss();
    });
  }

  /** Assertions never move the cursor: hovering could change the state being asserted. */
  assertVisible(stepId: string, label: string, role: string, name: string, timeoutMs = 5_000, planStep?: string | null) {
    return this.step({ step_id: stepId, label, action: 'assert', mode: 'ELEMENT', plan_step: planStep ?? null }, async () => {
      const el = this.page.getByRole(role as AriaRole, { name, exact: true });
      await this.visible(el, `${role} "${name}"`, timeoutMs);
      await this.target(stepId, el, false);
    });
  }

  assertText(stepId: string, label: string, role: string, name: string, contains: string, timeoutMs = 5_000, planStep?: string | null) {
    return this.step({ step_id: stepId, label, action: 'assert', mode: 'ELEMENT', plan_step: planStep ?? null }, async () => {
      const el = this.page.getByRole(role as AriaRole, { name, exact: true });
      await this.visible(el, `${role} "${name}"`, timeoutMs);
      await this.target(stepId, el, false);
      // biome-ignore lint/performance/useDomNodeTextContent: innerText is the visible text the spec requires
      const text = await el.innerText();
      if (!text.includes(contains)) throw new AssertionFailure(`Expected ${role} "${name}" to contain "${contains}"`);
    });
  }

  /** Records a visual assertion judged by the agent from the screenshot it was just given. */
  recordVerdict(stepId: string, label: string, status: Status, reasoning: string, planStep?: string | null) {
    return this.step({ step_id: stepId, label, action: 'assert', mode: 'AGENT', plan_step: planStep ?? null }, async () => {
      if (status === 'FAILED') throw new AssertionFailure(reasoning);
    });
  }

  /** Asserts the current URL matches a regular expression (§15.3 assert_url). */
  assertUrl(stepId: string, label: string, matches: string, planStep?: string | null) {
    return this.step({ step_id: stepId, label, action: 'assert', mode: 'AGENT', plan_step: planStep ?? null }, async () => {
      if (!new RegExp(matches).test(this.page.url())) {
        throw new AssertionFailure(`Expected URL to match ${matches}, got ${this.page.url()}`);
      }
    });
  }

  /**
   * §15.3 upload: setInputFiles when the ref IS a file input, otherwise click it while
   * waiting for the filechooser event (Playwright intercepts it; no native dialog).
   */
  upload(stepId: string, label: string, ref: string, resolvePaths: () => string[], planStep?: string | null) {
    return this.step({ step_id: stepId, label, action: 'upload', mode: 'ELEMENT', plan_step: planStep ?? null }, async () => {
      const absPaths = resolvePaths(); // validation errors land inside the ACTION pair
      const el = this.page.getByRef(ref);
      await this.target(stepId, el, true);
      const isFileInput = await el.evaluate((e) => e instanceof HTMLInputElement && e.type === 'file');
      if (isFileInput) {
        await el.setInputFiles(absPaths);
        return;
      }
      const [chooser] = await Promise.all([this.page.waitForEvent('filechooser', { timeout: 5000 }), el.click()]);
      await chooser.setFiles(absPaths);
    });
  }

  /** §15.3 step_done: an AGENT-mode ACTION pair that closes a plan step with the agent's verdict. */
  stepDone(stepId: string, label: string, planStep: string, status: Status, notes: string) {
    this.log.emit({ type: 'ACTION_START', step_id: stepId, label, action: 'step', mode: 'AGENT', plan_step: planStep });
    this.log.emit({ type: 'ACTION_END', step_id: stepId, status, notes });
    return Promise.resolve();
  }
}
