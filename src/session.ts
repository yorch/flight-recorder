import { type Browser, chromium, type Dialog, type Page } from 'playwright-core';
import type { Size } from './events.ts';

export class Session {
  readonly browser: Browser;
  page: Page; // the active page: the most recently opened one that is still open
  dialog: Dialog | null = null; // an open JS dialog awaiting the agent's `dialog` action (§6.5)
  violation: string | null = null; // set on a disallowed navigation or a page that breaks the invariant; fails the run

  private readonly screen: Size;
  private readonly allowedOrigins: string[];
  private readonly isAllowedUrl: (url: string) => boolean;

  private constructor(browser: Browser, page: Page, screen: Size, allowedOrigins: string[], isAllowedUrl: (url: string) => boolean) {
    this.browser = browser;
    this.page = page;
    this.screen = screen;
    this.allowedOrigins = allowedOrigins;
    this.isAllowedUrl = isAllowedUrl;
  }

  static async connect(cdpUrl: string, screen: Size, allowedOrigins: string[], isAllowedUrl: (url: string) => boolean): Promise<Session> {
    const browser = await chromium.connectOverCDP(cdpUrl);
    const context = browser.contexts()[0];
    if (!context) throw new Error('No browser context over CDP');
    const session = new Session(browser, context.pages()[0] ?? (await context.newPage()), screen, allowedOrigins, isAllowedUrl);
    await session.adopt(session.page);
    context.on('page', (page) => {
      session.adopt(page).catch((err) => {
        session.violation = String(err);
      });
    });
    return session;
  }

  private async adopt(page: Page): Promise<void> {
    page.on('dialog', (d) => {
      if (d.type() === 'beforeunload') void d.accept();
      else this.dialog = d;
    });
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame() || frame.url() === 'about:blank') return;
      let origin: string;
      try {
        origin = new URL(frame.url()).origin;
      } catch {
        return;
      }
      if (!this.allowedOrigins.includes(origin) && !this.isAllowedUrl(frame.url())) {
        this.violation = `Navigated outside allowed_origins: ${origin}`;
      }
    });
    page.on('close', () => {
      if (this.page === page) this.page = page.context().pages().at(-1) ?? page;
    });
    await page.waitForLoadState('domcontentloaded');
    const geo = await page.evaluate(() => ({ sx: screenX, sy: screenY, w: innerWidth, h: innerHeight, dpr: devicePixelRatio }));
    if (geo.sx !== 0 || geo.sy !== 0 || geo.w !== this.screen.width || geo.h !== this.screen.height || geo.dpr !== 1) {
      throw new Error(`Screen/viewport invariant violated: ${JSON.stringify(geo)}`);
    }
    this.page = page;
  }
}
