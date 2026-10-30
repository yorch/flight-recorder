import { performance } from 'node:perf_hooks';

export const nowMs = (): number => performance.timeOrigin + performance.now();

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
