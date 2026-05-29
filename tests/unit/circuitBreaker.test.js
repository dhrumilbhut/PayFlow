/**
 * Circuit breaker behavior tests.
 *
 * We test the circuit breaker state transitions and fast-fail behavior.
 * We don't import the actual circuitBreaker module (it has side effects)
 * — instead we test the opossum library behavior directly.
 */
const CircuitBreaker = require('opossum');

describe('Circuit Breaker Behavior', () => {
  let breaker;
  let callCount;

  beforeEach(() => {
    callCount = 0;

    // Create a test action that always fails
    const alwaysFails = async () => {
      callCount++;
      throw new Error('Gateway failure');
    };

    breaker = new CircuitBreaker(alwaysFails, {
      errorThresholdPercentage: 50,
      volumeThreshold: 3,
      resetTimeout: 200, // 200ms for fast tests
      timeout: 1000,
    });
  });

  afterEach(() => {
    breaker.shutdown();
  });

  test('starts in CLOSED state', () => {
    expect(breaker.opened).toBe(false);
    expect(breaker.halfOpen).toBe(false);
  });

  test('opens after enough failures', async () => {
    // Trigger enough failures to open the circuit
    for (let i = 0; i < 5; i++) {
      try { await breaker.fire(); } catch (_) {}
    }
    expect(breaker.opened).toBe(true);
  });

  test('rejects calls immediately when OPEN (fast fail)', async () => {
    // Open the circuit
    for (let i = 0; i < 5; i++) {
      try { await breaker.fire(); } catch (_) {}
    }

    const beforeCount = callCount;
    try { await breaker.fire(); } catch (_) {}
    // When circuit is open, the underlying function should NOT be called
    expect(callCount).toBe(beforeCount);
  });

  test('transitions to HALF_OPEN after reset timeout', async () => {
    // Open the circuit
    for (let i = 0; i < 5; i++) {
      try { await breaker.fire(); } catch (_) {}
    }
    expect(breaker.opened).toBe(true);

    // Wait for reset timeout
    await new Promise((r) => setTimeout(r, 250));
    expect(breaker.halfOpen).toBe(true);
  });
});
