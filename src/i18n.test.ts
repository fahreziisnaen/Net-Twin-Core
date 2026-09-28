import { describe, test, expect } from 'vitest';
import { translate } from './i18n';

describe('i18n translate', () => {
  test('English is the default: returns the key verbatim', () => {
    expect(translate('en', 'Path Simulator')).toBe('Path Simulator');
    expect(translate('en', 'Add New Device')).toBe('Add New Device');
  });

  test('Indonesian returns the mapped translation', () => {
    expect(translate('id', 'Path Simulator')).toBe('Simulator Jalur');
    expect(translate('id', 'Add New Device')).toBe('Tambah Device Baru');
    expect(translate('id', 'Save')).toBe('Simpan');
  });

  test('unknown keys fall back to English (never crash)', () => {
    expect(translate('id', 'Some brand-new untranslated string')).toBe('Some brand-new untranslated string');
    expect(translate('en', 'Whatever')).toBe('Whatever');
  });

  test('inserts values literally, even ones that look like replacement patterns', () => {
    expect(translate('en', 'Delete user "{name}"?', { name: "a$&b$'c" })).toBe('Delete user "a$&b$\'c"?');
  });

  test('inherited object keys are not translations', () => {
    expect(translate('id', 'constructor')).toBe('constructor');
  });

  test('interpolates {vars} in both languages', () => {
    expect(translate('en', 'Apply {n} items to Digital Twin', { n: 3 })).toBe('Apply 3 items to Digital Twin');
    expect(translate('id', 'Apply {n} items to Digital Twin', { n: 3 })).toBe('Apply 3 item ke Digital Twin');
    expect(translate('id', 'Delete user "{name}"?', { name: 'bob' })).toBe('Hapus user "bob"?');
  });
});
