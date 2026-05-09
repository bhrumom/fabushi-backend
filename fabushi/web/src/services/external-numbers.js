export const USER_NO_LENGTH = 9;
export const GROUP_NO_MIN_LENGTH = 5;
export const GROUP_NO_MAX_LENGTH = 8;
export const GROUP_NO_LENGTH = GROUP_NO_MIN_LENGTH;

const UINT32_SIZE = 0x100000000;

export function generateSecureInteger(min, max) {
  const lower = Math.trunc(Number(min));
  const upper = Math.trunc(Number(max));
  if (!Number.isSafeInteger(lower) || !Number.isSafeInteger(upper) || upper < lower) {
    throw new Error('secure random range is invalid');
  }

  const range = upper - lower + 1;
  if (range <= 0 || range > UINT32_SIZE) {
    throw new Error('secure random range exceeds uint32 support');
  }
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error('crypto.getRandomValues is required');
  }

  const limit = Math.floor(UINT32_SIZE / range) * range;
  const buffer = new Uint32Array(1);
  let value;
  do {
    globalThis.crypto.getRandomValues(buffer);
    value = buffer[0];
  } while (value >= limit);

  return lower + (value % range);
}

export function generateExternalNumericNo(length) {
  const normalizedLength = Math.trunc(Number(length));
  if (!Number.isSafeInteger(normalizedLength) || normalizedLength < 2 || normalizedLength > 9) {
    throw new Error('external number length must be between 2 and 9 digits');
  }

  const min = 10 ** (normalizedLength - 1);
  const max = (10 ** normalizedLength) - 1;
  return generateSecureInteger(min, max);
}

export function generateUserNo() {
  return generateExternalNumericNo(USER_NO_LENGTH);
}

export function generateGroupNo(length = GROUP_NO_LENGTH) {
  return generateExternalNumericNo(length);
}
