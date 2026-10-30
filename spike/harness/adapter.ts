import type { BrowserContext, Page } from 'playwright-core';

export interface Adapter {
  readonly arm: string;
  connect(extraArgs: string[]): Promise<{ page: Page; context: BrowserContext }>;
  startRecording(): Promise<number | null>;
  stopRecording(): Promise<void>;
  osClick(x: number, y: number): Promise<void>;
  onSegmentStart(name: string): void;
  onSegmentEnd(name: string): void;
}
