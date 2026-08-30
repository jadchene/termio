import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeFontFamilies } from '../src/utils/systemFonts';

test('system font families are deduplicated and retain saved fonts', () => {
  assert.deepEqual(
    normalizeFontFamilies(['Consolas', 'Arial', 'consolas', ''], ['Custom Mono']),
    ['Arial', 'Consolas', 'Custom Mono'],
  );
});
