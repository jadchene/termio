export type StoredHostKeyTrust = {
  fingerprint: string;
  keyBase64: string;
};

type VerifyHostKeyTrustOptions = {
  stored?: StoredHostKeyTrust;
  keyBase64: string;
  requestConfirmation: (expectedFingerprint?: string) => Promise<boolean>;
  save: () => Promise<void>;
  onMismatchRejected?: () => void;
};

export const verifyHostKeyTrust = async (options: VerifyHostKeyTrustOptions): Promise<boolean> => {
  const { stored, keyBase64, requestConfirmation, save, onMismatchRejected } = options;
  if (stored?.keyBase64 === keyBase64) return true;

  const accepted = await requestConfirmation(stored?.fingerprint);
  if (!accepted) {
    if (stored) onMismatchRejected?.();
    return false;
  }

  await save();
  return true;
};
