// Markdown files are imported as their text: Vite does it with `?raw` in the app and in vitest, and
// evals/raw-text-hooks.ts does it for the evals that run in plain Node.
declare module '*.md?raw' {
  const text: string;
  export default text;
}
