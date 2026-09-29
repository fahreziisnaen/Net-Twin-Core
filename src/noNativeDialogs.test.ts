import { describe, test, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// The UI uses in-app modals (components/DialogProvider). The browser's own
// alert/confirm/prompt block the page, can't be styled or translated, and some
// embedded browsers suppress them — keep them out of the source.
const NATIVE_DIALOG = /(?<![.\w$])(?:alert|confirm|prompt)\s*\(|window\.(?:alert|confirm|prompt)\s*\(/;

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe('no native browser dialogs', () => {
  test('src/ uses the in-app dialog instead of alert/confirm/prompt', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(path.join(__dirname))) {
      fs.readFileSync(file, 'utf-8').split(/\r?\n/).forEach((line, i) => {
        if (NATIVE_DIALOG.test(line)) offenders.push(`${path.relative(__dirname, file)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
