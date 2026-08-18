import assert from 'node:assert/strict';
import test from 'node:test';
import { isMetricsPanelVisible, resolveMetricsSessionId } from '../src/utils/metricsVisibility';

test('remote metrics run only while the status panel is visible', () => {
  assert.equal(isMetricsPanelVisible('status', true), true);
  assert.equal(isMetricsPanelVisible('sessions', true), false);
  assert.equal(isMetricsPanelVisible('status', false), false);
  assert.equal(resolveMetricsSessionId(42, 'status', true), 42);
  assert.equal(resolveMetricsSessionId(42, 'sftp', true), null);
  assert.equal(resolveMetricsSessionId(42, 'status', false), null);
  assert.equal(resolveMetricsSessionId(null, 'status', true), null);
});
