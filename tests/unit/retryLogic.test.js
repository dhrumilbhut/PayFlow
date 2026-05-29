const { calculateRetryDelay, isRetryEligible } = require('../../src/services/paymentService');
const { STATES } = require('../../src/state-machine/paymentStateMachine');

/**
 * Test the exponential backoff formula and retry eligibility.
 * These are pure functions — no mocking needed.
 */
describe('Retry Logic', () => {

  describe('calculateRetryDelay (exponential backoff)', () => {
    // Formula: baseDelay * 2^retryCount
    // baseDelay = 2000ms (from config)

    test('attempt 0 → 2 seconds', () => {
      const delay = calculateRetryDelay(0);
      expect(delay).toBe(2000); // 2000 * 2^0 = 2000
    });

    test('attempt 1 → 4 seconds', () => {
      const delay = calculateRetryDelay(1);
      expect(delay).toBe(4000); // 2000 * 2^1 = 4000
    });

    test('attempt 2 → 8 seconds', () => {
      const delay = calculateRetryDelay(2);
      expect(delay).toBe(8000); // 2000 * 2^2 = 8000
    });

    test('delays are strictly increasing', () => {
      const delays = [0, 1, 2, 3].map(calculateRetryDelay);
      for (let i = 1; i < delays.length; i++) {
        expect(delays[i]).toBeGreaterThan(delays[i - 1]);
      }
    });
  });

  describe('isRetryEligible', () => {
    function makePayment(overrides = {}) {
      return {
        status: STATES.PROCESSING,
        retryCount: 0,
        maxRetries: 3,
        ...overrides,
      };
    }

    test('eligible when retryCount < maxRetries and not terminal', () => {
      expect(isRetryEligible(makePayment({ retryCount: 0 }))).toBe(true);
      expect(isRetryEligible(makePayment({ retryCount: 2 }))).toBe(true);
    });

    test('not eligible when retryCount >= maxRetries', () => {
      expect(isRetryEligible(makePayment({ retryCount: 3 }))).toBe(false);
      expect(isRetryEligible(makePayment({ retryCount: 5 }))).toBe(false);
    });

    test('not eligible when status is SUCCESS (terminal)', () => {
      expect(isRetryEligible(makePayment({ status: STATES.SUCCESS }))).toBe(false);
    });

    test('not eligible when status is FAILED (terminal)', () => {
      expect(isRetryEligible(makePayment({ status: STATES.FAILED }))).toBe(false);
    });
  });
});
