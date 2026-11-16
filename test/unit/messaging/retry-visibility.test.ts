import { describe, expect, test } from 'bun:test';
import { retryVisibilitySeconds } from '../../../src/infrastructure/messaging/retry-visibility';

// SPEC 10.3; RN-35; ADR-0010: espera da ADR-0007 a partir de ApproximateReceiveCount.
const MIDDLE = () => 0.5;
const LOWEST = () => 0;

describe('retryVisibilitySeconds', () => {
  test.each([
    [1, MIDDLE, 2],
    [2, MIDDLE, 4],
    [3, MIDDLE, 8],
    [1, LOWEST, 2], // 1,6 s arredonda para cima
    [9, MIDDLE, 300], // teto de 5 min
    [20, MIDDLE, 300],
  ])('ApproximateReceiveCount %i: %p s', (receiveCount, random, expected) => {
    expect(retryVisibilitySeconds(receiveCount, random)).toBe(expected);
  });
});
