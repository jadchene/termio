import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveTabsAfterClose } from '../src/utils/tabNavigation';

const tabs = [{ id: 1 }, { id: 2 }, { id: 3 }];

test('closing the active tab selects its right-hand neighbour', () => {
  assert.deepEqual(resolveTabsAfterClose(tabs, 2, 2), { tabs: [{ id: 1 }, { id: 3 }], activeTabId: 3 });
});

test('closing the last active tab selects its left-hand neighbour', () => {
  assert.equal(resolveTabsAfterClose(tabs, 3, 3).activeTabId, 2);
});

test('closing a background tab preserves the active tab', () => {
  assert.equal(resolveTabsAfterClose(tabs, 2, 1).activeTabId, 2);
});
