/**
 * Webhook idempotency and conflict resolution tests.
 */

const request = require('supertest');

jest.mock('../../src/database/connection', () => ({
  query: jest.fn(),
  withTransaction: jest.fn((fn) => {
    const mockClient = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    return fn(mockClient);
  }),
  checkHealth: jest.fn().mockResolvedValue(true),
  close: jest.fn(),
}));

jest.mock('../../src/locks/redisLock', () => ({
  withLock: jest.fn((key, ttl, fn) => fn()),
  checkHealth: jest.fn().mockResolvedValue(true),
  close: jest.fn(),
}));

jest.mock('../../src/messaging/rabbitmq', () => ({
  connect: jest.fn(),
  publishPaymentProcess: jest.fn(),
  publishPaymentRetry: jest.fn(),
  checkHealth: jest.fn().mockResolvedValue(true),
  close: jest.fn(),
}));

jest.mock('../../src/repositories/paymentRepository');
jest.mock('../../src/repositories/webhookRepository');
jest.mock('../../src/repositories/eventRepository');
jest.mock('../../src/audit/auditService', () => ({
  record: jest.fn().mockResolvedValue({}),
  AUDIT_EVENTS: {
    WEBHOOK_RECEIVED: 'WEBHOOK_RECEIVED',
    PAYMENT_SUCCESS: 'PAYMENT_SUCCESS',
    PAYMENT_FAILED: 'PAYMENT_FAILED',
  },
}));

const app = require('../../src/server');
const paymentRepo = require('../../src/repositories/paymentRepository');
const webhookRepo = require('../../src/repositories/webhookRepository');

const paymentId = '550e8400-e29b-41d4-a716-446655440000';
const eventId = 'gw-event-123';

const baseWebhook = { eventId, paymentId, status: 'SUCCESS', timestamp: new Date().toISOString() };

describe('POST /webhook', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns 422 when eventId is missing', async () => {
    const res = await request(app).post('/webhook').send({ paymentId, status: 'SUCCESS' });
    expect(res.status).toBe(422);
  });

  test('returns 422 for invalid paymentId UUID', async () => {
    const res = await request(app).post('/webhook').send({ eventId, paymentId: 'bad-id', status: 'SUCCESS' });
    expect(res.status).toBe(422);
  });

  test('handles duplicate webhook idempotently', async () => {
    // Simulate: webhook was already processed
    webhookRepo.findByExternalEventId.mockResolvedValue({ id: 'existing' });

    const res = await request(app).post('/webhook').send(baseWebhook);

    expect(res.status).toBe(200);
    expect(res.body.message).toContain('Duplicate');
    // Should NOT have looked up the payment at all (early exit)
    expect(paymentRepo.lockForUpdate).not.toHaveBeenCalled();
  });

  test('processes webhook for PROCESSING payment', async () => {
    webhookRepo.findByExternalEventId.mockResolvedValue(null);
    webhookRepo.create.mockResolvedValue({});
    paymentRepo.lockForUpdate.mockResolvedValue({
      id: paymentId, status: 'PROCESSING', retryCount: 0, maxRetries: 3,
    });
    paymentRepo.updateStatus.mockResolvedValue({ id: paymentId, status: 'SUCCESS' });

    const res = await request(app).post('/webhook').send(baseWebhook);

    expect(res.status).toBe(200);
  });

  test('reconciles FAILED payment to SUCCESS when webhook says SUCCESS', async () => {
    webhookRepo.findByExternalEventId.mockResolvedValue(null);
    webhookRepo.create.mockResolvedValue({});
    paymentRepo.lockForUpdate.mockResolvedValue({
      id: paymentId, status: 'FAILED', retryCount: 3, maxRetries: 3,
    });
    paymentRepo.updateStatus.mockResolvedValue({ id: paymentId, status: 'SUCCESS' });

    const res = await request(app).post('/webhook').send(baseWebhook);

    expect(res.status).toBe(200);
    // Should have called updateStatus to reconcile
    expect(paymentRepo.updateStatus).toHaveBeenCalledWith(
      paymentId, 'SUCCESS', expect.any(Object), expect.anything()
    );
  });

  test('ignores FAILED webhook when payment is already SUCCESS', async () => {
    webhookRepo.findByExternalEventId.mockResolvedValue(null);
    webhookRepo.create.mockResolvedValue({});
    paymentRepo.lockForUpdate.mockResolvedValue({
      id: paymentId, status: 'SUCCESS', retryCount: 0, maxRetries: 3,
    });

    const res = await request(app).post('/webhook').send({
      ...baseWebhook, status: 'FAILED',
    });

    expect(res.status).toBe(200);
    // Should NOT update status
    expect(paymentRepo.updateStatus).not.toHaveBeenCalled();
  });
});
