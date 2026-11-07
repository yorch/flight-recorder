// Minimal typing for the `bun:test` API this suite uses. Keeping it local avoids
// pulling @types/bun's global DOM/fetch augmentations into the Node-typed sources.
declare module 'bun:test' {
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void | Promise<void>, timeoutMs?: number): void;
  export function afterAll(fn: () => void | Promise<void>): void;
}
