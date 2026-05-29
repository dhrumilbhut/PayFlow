/**
 * Payment Processor Unit Tests
 *
 * This is the most critical file in the system — it orchestrates:
 *   Redis lock → DB row lock → state transition → gateway → retry/success/fail
 *
 * We mock all I/O (DB, Redis, RabbitMQ, gateway) and test the
 * LOGIC of the processor: correct state transitions, retry scheduling,
 * exponential backoff values, duplicate message handling, and failure paths.
 */

jest.mock('../../src/database/connection');
jest.mock('../../src/repositories/paymentRepository');
jest.mock('../../src/audit/auditService');
jest.mock('../../src/gateway/circuitBreaker');
jest.mock('../../src/messaging/rabbitmq');
jest.mock('../../src/locks/redisLock');

const db            = require('../../src/database/connection');
const paymentRepo   = require('../../src/repositories/paymentRepository');
const audit         = require('../../src/audit/auditService');
const { executeCharge } = require('../../src/gateway/circuitBreaker');
const { publishPaymentRetry } = require('../../src/messaging/rabbitmq');
const { withLock }  = require('../../src/locks/redisLock');
const { processPayment } = require('../../src/services/paymentProcessor');
const { STATES }    = require('../../src/state-machine/paymentStateMachine');

// ── Shared mock setup ────────────────────────────────────────────────────────

const PAYMENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function makePayment(overrides = {}) {
  return {
    id:         PAYMENT_ID,
    amount:     100.00,
    status:     STATES.PENDING,
    retryCount: 0,
    maxRetries: 3,
    lastError:  null,
    ...overrides,
  };
}

// withLock just calls the function (no actual Redis in tests)
withLock.mockImplementation((_key, _ttl, fn) => fn());

// withTransaction just calls the function with a mock client
const mockClient = { query: jest.fn().mockResolvedValue({ rows: [] }) };
db.withTransaction.mockImplementation((fn) => fn(mockClient));

// audit.record is fire-and-forget — just resolve
audit.record.mockResolvedValue({});
audit.AUDIT_EVENTS = {
  PAYMENT_PROCESSING_STARTED: 'PAYMENT_PROCESSING_STARTED',
  GATEWAY_REQUEST_SENT:       'GATEWAY_REQUEST_SENT',
  GATEWAY_SUCCESS:            'GATEWAY_SUCCESS',
  GATEWAY_FAILURE:            'GATEWAY_FAILURE',
  GATEWAY_TIMEOUT:            'GATEWAY_TIMEOUT',
  PAYMENT_RETRY_SCHEDULED:    'PAYMENT_RETRY_SCHEDULED',
  PAYMENT_SUCCESS:            'PAYMENT_SUCCESS',
  PAYMENT_FAILED:             'PAYMENT_FAILED',
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Payment Processor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    withLock.mockImplementation((_key, _ttl, fn) => fn());
    db.withTransaction.mockImplementation((fn) => fn(mockClient));
    audit.record.mockResolvedValue({});
    publishPaymentRetry.mockResolvedValue(undefined);
  });

  // ── Happy path ─────────────────────────────────────────────────────────────

  describe('successful payment', () => {
    test('transitions PENDING → PROCESSING → SUCCESS', async () => {
      const payment = makePayment({ status: STATES.PENDING });

      // First lockForUpdate: payment in PENDING state
      // Second lockForUpdate (after gateway): fresh payment in PROCESSING
      paymentRepo.lockForUpdate
        .mockResolvedValueOnce(payment)
        .mockResolvedValueOnce({ ...payment, status: STATES.PROCESSING });

      paymentRepo.updateStatus.mockResolvedValue({ ...payment, status: STATES.SUCCESS });

      executeCharge.mockResolvedValue({
        success: true,
        gatewayRef: 'GW-TEST1234',
        gatewayEventId: 'evt-001',
      });

      await processPayment({ paymentId: PAYMENT_ID, attempt: 0, trigger: 'INITIAL' });

      // Should have updated status to PROCESSING first, then to SUCCESS
      expect(paymentRepo.updateStatus).toHaveBeenCalledWith(
        PAYMENT_ID, STATES.PROCESSING, {}, mockClient
      );
      expect(paymentRepo.updateStatus).toHaveBeenCalledWith(
        PAYMENT_ID, STATES.SUCCESS,
        expect.objectContaining({ lastError: null }),
        mockClient
      );
    });

    test('records PAYMENT_SUCCESS audit event on success', async () => {
      const payment = makePayment();
      paymentRepo.lockForUpdate
        .mockResolvedValueOnce(payment)
        .mockResolvedValueOnce({ ...payment, status: STATES.PROCESSING });
      paymentRepo.updateStatus.mockResolvedValue({});
      executeCharge.mockResolvedValue({ success: true, gatewayRef: 'GW-OK', gatewayEventId: 'e1' });

      await processPayment({ paymentId: PAYMENT_ID, attempt: 0, trigger: 'INITIAL' });

      const successEvent = audit.record.mock.calls.find(
        ([arg]) => arg.eventType === 'PAYMENT_SUCCESS'
      );
      expect(successEvent).toBeDefined();
    });
  });

  // ── Failure & retry ────────────────────────────────────────────────────────

  describe('gateway failure with retries remaining', () => {
    test('transitions PROCESSING → RETRY_SCHEDULED and publishes retry message', async () => {
      const payment = makePayment({ retryCount: 0, maxRetries: 3 });
      paymentRepo.lockForUpdate
        .mockResolvedValueOnce(payment)
        .mockResolvedValueOnce({ ...payment, status: STATES.PROCESSING });
      paymentRepo.updateStatus.mockResolvedValue({});

      const gatewayError = new Error('Payment declined');
      gatewayError.code = 'GATEWAY_FAILURE';
      executeCharge.mockRejectedValue(gatewayError);

      await processPayment({ paymentId: PAYMENT_ID, attempt: 0, trigger: 'INITIAL' });

      // Should schedule retry, not fail permanently
      expect(paymentRepo.updateStatus).toHaveBeenCalledWith(
        PAYMENT_ID, STATES.RETRY_SCHEDULED,
        expect.objectContaining({ retryCount: 1 }),
        mockClient
      );

      // Should NOT mark as FAILED
      const failedCall = paymentRepo.updateStatus.mock.calls.find(
        ([_id, status]) => status === STATES.FAILED
      );
      expect(failedCall).toBeUndefined();
    });

    test('exponential backoff: attempt 0 → 2s delay', async () => {
      const payment = makePayment({ retryCount: 0 });
      paymentRepo.lockForUpdate
        .mockResolvedValueOnce(payment)
        .mockResolvedValueOnce({ ...payment, status: STATES.PROCESSING });
      paymentRepo.updateStatus.mockResolvedValue({});
      executeCharge.mockRejectedValue(Object.assign(new Error('fail'), { code: 'GATEWAY_FAILURE' }));

      await processPayment({ paymentId: PAYMENT_ID, attempt: 0, trigger: 'INITIAL' });

      // Wait for process.nextTick to fire
      await new Promise((r) => setTimeout(r, 10));

      expect(publishPaymentRetry).toHaveBeenCalledWith(PAYMENT_ID, 1, 2000);
    });

    test('exponential backoff: attempt 1 → 4s delay', async () => {
      const payment = makePayment({ retryCount: 1 });
      paymentRepo.lockForUpdate
        .mockResolvedValueOnce(payment)
        .mockResolvedValueOnce({ ...payment, status: STATES.PROCESSING });
      paymentRepo.updateStatus.mockResolvedValue({});
      executeCharge.mockRejectedValue(Object.assign(new Error('fail'), { code: 'GATEWAY_FAILURE' }));

      await processPayment({ paymentId: PAYMENT_ID, attempt: 1, trigger: 'RETRY' });

      await new Promise((r) => setTimeout(r, 10));

      expect(publishPaymentRetry).toHaveBeenCalledWith(PAYMENT_ID, 2, 4000);
    });

    test('exponential backoff: attempt 2 → 8s delay', async () => {
      const payment = makePayment({ retryCount: 2 });
      paymentRepo.lockForUpdate
        .mockResolvedValueOnce(payment)
        .mockResolvedValueOnce({ ...payment, status: STATES.PROCESSING });
      paymentRepo.updateStatus.mockResolvedValue({});
      executeCharge.mockRejectedValue(Object.assign(new Error('fail'), { code: 'GATEWAY_FAILURE' }));

      await processPayment({ paymentId: PAYMENT_ID, attempt: 2, trigger: 'RETRY' });

      await new Promise((r) => setTimeout(r, 10));

      expect(publishPaymentRetry).toHaveBeenCalledWith(PAYMENT_ID, 3, 8000);
    });
  });

  // ── Max retries exhausted ──────────────────────────────────────────────────

  describe('max retries exhausted', () => {
    test('transitions to FAILED when retryCount >= maxRetries', async () => {
      // retryCount === maxRetries → no more retries
      const payment = makePayment({ retryCount: 3, maxRetries: 3 });
      paymentRepo.lockForUpdate
        .mockResolvedValueOnce(payment)
        .mockResolvedValueOnce({ ...payment, status: STATES.PROCESSING });
      paymentRepo.updateStatus.mockResolvedValue({});
      executeCharge.mockRejectedValue(Object.assign(new Error('declined'), { code: 'GATEWAY_FAILURE' }));

      await processPayment({ paymentId: PAYMENT_ID, attempt: 3, trigger: 'RETRY' });

      expect(paymentRepo.updateStatus).toHaveBeenCalledWith(
        PAYMENT_ID, STATES.FAILED,
        expect.objectContaining({ lastError: expect.any(String) }),
        mockClient
      );

      // Should NOT publish a retry message
      await new Promise((r) => setTimeout(r, 10));
      expect(publishPaymentRetry).not.toHaveBeenCalled();
    });

    test('records PAYMENT_FAILED audit event', async () => {
      const payment = makePayment({ retryCount: 3, maxRetries: 3 });
      paymentRepo.lockForUpdate
        .mockResolvedValueOnce(payment)
        .mockResolvedValueOnce({ ...payment, status: STATES.PROCESSING });
      paymentRepo.updateStatus.mockResolvedValue({});
      executeCharge.mockRejectedValue(Object.assign(new Error('declined'), { code: 'GATEWAY_FAILURE' }));

      await processPayment({ paymentId: PAYMENT_ID, attempt: 3, trigger: 'RETRY' });

      const failedEvent = audit.record.mock.calls.find(
        ([arg]) => arg.eventType === 'PAYMENT_FAILED'
      );
      expect(failedEvent).toBeDefined();
    });
  });

  // ── Gateway timeout ────────────────────────────────────────────────────────

  describe('gateway timeout', () => {
    test('timeout counts as a failure and schedules retry', async () => {
      const payment = makePayment({ retryCount: 0 });
      paymentRepo.lockForUpdate
        .mockResolvedValueOnce(payment)
        .mockResolvedValueOnce({ ...payment, status: STATES.PROCESSING });
      paymentRepo.updateStatus.mockResolvedValue({});

      const timeoutError = new Error('Gateway timeout');
      timeoutError.code = 'GATEWAY_TIMEOUT';
      executeCharge.mockRejectedValue(timeoutError);

      await processPayment({ paymentId: PAYMENT_ID, attempt: 0, trigger: 'INITIAL' });

      expect(paymentRepo.updateStatus).toHaveBeenCalledWith(
        PAYMENT_ID, STATES.RETRY_SCHEDULED,
        expect.any(Object),
        mockClient
      );
    });

    test('records GATEWAY_TIMEOUT audit event (not GATEWAY_FAILURE)', async () => {
      const payment = makePayment({ retryCount: 0 });
      paymentRepo.lockForUpdate
        .mockResolvedValueOnce(payment)
        .mockResolvedValueOnce({ ...payment, status: STATES.PROCESSING });
      paymentRepo.updateStatus.mockResolvedValue({});

      const timeoutError = new Error('Gateway timeout');
      timeoutError.code = 'GATEWAY_TIMEOUT';
      executeCharge.mockRejectedValue(timeoutError);

      await processPayment({ paymentId: PAYMENT_ID, attempt: 0, trigger: 'INITIAL' });

      const timeoutEvent = audit.record.mock.calls.find(
        ([arg]) => arg.eventType === 'GATEWAY_TIMEOUT'
      );
      expect(timeoutEvent).toBeDefined();

      // Must NOT record GATEWAY_FAILURE for a timeout
      const failureEvent = audit.record.mock.calls.find(
        ([arg]) => arg.eventType === 'GATEWAY_FAILURE'
      );
      expect(failureEvent).toBeUndefined();
    });
  });

  // ── Duplicate message handling ─────────────────────────────────────────────

  describe('duplicate / stale message handling', () => {
    test('skips processing if payment is already SUCCESS', async () => {
      // Worker receives a stale/duplicate message for an already-SUCCESS payment
      paymentRepo.lockForUpdate.mockResolvedValue(
        makePayment({ status: STATES.SUCCESS })
      );

      await processPayment({ paymentId: PAYMENT_ID, attempt: 0, trigger: 'INITIAL' });

      // Should NOT update status (payment is already done)
      expect(paymentRepo.updateStatus).not.toHaveBeenCalled();
      expect(executeCharge).not.toHaveBeenCalled();
    });

    test('skips processing if payment is already FAILED', async () => {
      paymentRepo.lockForUpdate.mockResolvedValue(
        makePayment({ status: STATES.FAILED })
      );

      await processPayment({ paymentId: PAYMENT_ID, attempt: 0, trigger: 'INITIAL' });

      expect(paymentRepo.updateStatus).not.toHaveBeenCalled();
      expect(executeCharge).not.toHaveBeenCalled();
    });

    test('skips if payment row is already locked (SKIP LOCKED returns null)', async () => {
      // SKIP LOCKED — row is held by another worker, returns null
      paymentRepo.lockForUpdate.mockResolvedValue(null);

      await processPayment({ paymentId: PAYMENT_ID, attempt: 0, trigger: 'INITIAL' });

      expect(executeCharge).not.toHaveBeenCalled();
    });
  });

  // ── Redis lock contention ──────────────────────────────────────────────────

  describe('Redis lock contention', () => {
    test('does not throw when Redis lock cannot be acquired', async () => {
      const lockError = new Error('Could not acquire lock');
      lockError.code = 'LOCK_ACQUISITION_FAILED';
      withLock.mockRejectedValue(lockError);

      // Should resolve cleanly — another worker has this payment
      await expect(
        processPayment({ paymentId: PAYMENT_ID, attempt: 0, trigger: 'INITIAL' })
      ).resolves.not.toThrow();
    });
  });
});
