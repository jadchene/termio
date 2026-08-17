import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyHostKeyTrust } from '../electron/main/hostKeyTrust';

test('accepts an unchanged host key without confirmation or persistence', async () => {
  let confirmationCount = 0;
  let saveCount = 0;

  const accepted = await verifyHostKeyTrust({
    stored: { fingerprint: 'SHA256:old', keyBase64: 'same-key' },
    keyBase64: 'same-key',
    requestConfirmation: async () => {
      confirmationCount += 1;
      return false;
    },
    save: async () => {
      saveCount += 1;
    },
  });

  assert.equal(accepted, true);
  assert.equal(confirmationCount, 0);
  assert.equal(saveCount, 0);
});

test('rejects a changed host key without replacing the stored key', async () => {
  let mismatchCount = 0;
  let saveCount = 0;

  const accepted = await verifyHostKeyTrust({
    stored: { fingerprint: 'SHA256:old', keyBase64: 'old-key' },
    keyBase64: 'new-key',
    requestConfirmation: async (expectedFingerprint) => {
      assert.equal(expectedFingerprint, 'SHA256:old');
      return false;
    },
    save: async () => {
      saveCount += 1;
    },
    onMismatchRejected: () => {
      mismatchCount += 1;
    },
  });

  assert.equal(accepted, false);
  assert.equal(mismatchCount, 1);
  assert.equal(saveCount, 0);
});

test('replaces a changed host key only after explicit confirmation', async () => {
  let mismatchRejectedCount = 0;
  let saveCount = 0;

  const accepted = await verifyHostKeyTrust({
    stored: { fingerprint: 'SHA256:old', keyBase64: 'old-key' },
    keyBase64: 'new-key',
    requestConfirmation: async (expectedFingerprint) => {
      assert.equal(expectedFingerprint, 'SHA256:old');
      return true;
    },
    save: async () => {
      saveCount += 1;
    },
    onMismatchRejected: () => {
      mismatchRejectedCount += 1;
    },
  });

  assert.equal(accepted, true);
  assert.equal(mismatchRejectedCount, 0);
  assert.equal(saveCount, 1);
});

test('persists a first-use host key only after confirmation', async () => {
  let saveCount = 0;

  const accepted = await verifyHostKeyTrust({
    keyBase64: 'first-key',
    requestConfirmation: async (expectedFingerprint) => {
      assert.equal(expectedFingerprint, undefined);
      return true;
    },
    save: async () => {
      saveCount += 1;
    },
  });

  assert.equal(accepted, true);
  assert.equal(saveCount, 1);
});
