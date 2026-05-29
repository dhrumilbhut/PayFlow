const {
  canTransition,
  assertTransition,
  isTerminal,
  toExternalState,
  STATES,
} = require('../../src/state-machine/paymentStateMachine');

/**
 * State machine tests.
 *
 * These are pure unit tests — no DB, no network, no file I/O.
 * The state machine is the core business rule, so we test it exhaustively.
 */
describe('Payment State Machine', () => {

  describe('canTransition', () => {
    test('PENDING → PROCESSING is allowed', () => {
      expect(canTransition(STATES.PENDING, STATES.PROCESSING)).toBe(true);
    });

    test('PROCESSING → SUCCESS is allowed', () => {
      expect(canTransition(STATES.PROCESSING, STATES.SUCCESS)).toBe(true);
    });

    test('PROCESSING → RETRY_SCHEDULED is allowed', () => {
      expect(canTransition(STATES.PROCESSING, STATES.RETRY_SCHEDULED)).toBe(true);
    });

    test('PROCESSING → FAILED is allowed', () => {
      expect(canTransition(STATES.PROCESSING, STATES.FAILED)).toBe(true);
    });

    test('RETRY_SCHEDULED → PROCESSING is allowed', () => {
      expect(canTransition(STATES.RETRY_SCHEDULED, STATES.PROCESSING)).toBe(true);
    });

    // Terminal state guards
    test('SUCCESS → any transition is NOT allowed', () => {
      expect(canTransition(STATES.SUCCESS, STATES.PROCESSING)).toBe(false);
      expect(canTransition(STATES.SUCCESS, STATES.FAILED)).toBe(false);
      expect(canTransition(STATES.SUCCESS, STATES.PENDING)).toBe(false);
    });

    test('FAILED → any transition is NOT allowed', () => {
      expect(canTransition(STATES.FAILED, STATES.PROCESSING)).toBe(false);
      expect(canTransition(STATES.FAILED, STATES.SUCCESS)).toBe(false);
      expect(canTransition(STATES.FAILED, STATES.RETRY_SCHEDULED)).toBe(false);
    });

    test('PENDING → SUCCESS is NOT allowed (must go through PROCESSING)', () => {
      expect(canTransition(STATES.PENDING, STATES.SUCCESS)).toBe(false);
    });

    test('returns false for unknown states', () => {
      expect(canTransition('UNKNOWN', STATES.PROCESSING)).toBe(false);
      expect(canTransition(STATES.PENDING, 'UNKNOWN')).toBe(false);
    });
  });

  describe('assertTransition', () => {
    test('throws on invalid transition with correct error code', () => {
      expect(() => assertTransition(STATES.SUCCESS, STATES.PROCESSING)).toThrow();

      try {
        assertTransition(STATES.SUCCESS, STATES.PROCESSING);
      } catch (err) {
        expect(err.code).toBe('INVALID_STATE_TRANSITION');
        expect(err.currentState).toBe(STATES.SUCCESS);
        expect(err.nextState).toBe(STATES.PROCESSING);
      }
    });

    test('does NOT throw on valid transition', () => {
      expect(() => assertTransition(STATES.PENDING, STATES.PROCESSING)).not.toThrow();
    });
  });

  describe('isTerminal', () => {
    test('SUCCESS and FAILED are terminal', () => {
      expect(isTerminal(STATES.SUCCESS)).toBe(true);
      expect(isTerminal(STATES.FAILED)).toBe(true);
    });

    test('PENDING, PROCESSING, RETRY_SCHEDULED are not terminal', () => {
      expect(isTerminal(STATES.PENDING)).toBe(false);
      expect(isTerminal(STATES.PROCESSING)).toBe(false);
      expect(isTerminal(STATES.RETRY_SCHEDULED)).toBe(false);
    });
  });

  describe('toExternalState', () => {
    test('maps RETRY_SCHEDULED to PROCESSING (hidden internal state)', () => {
      expect(toExternalState(STATES.RETRY_SCHEDULED)).toBe('PROCESSING');
    });

    test('passes through standard states unchanged', () => {
      expect(toExternalState(STATES.PENDING)).toBe('PENDING');
      expect(toExternalState(STATES.PROCESSING)).toBe('PROCESSING');
      expect(toExternalState(STATES.SUCCESS)).toBe('SUCCESS');
      expect(toExternalState(STATES.FAILED)).toBe('FAILED');
    });
  });
});
