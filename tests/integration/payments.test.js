/**
 * Payment API Integration Tests
 *
 * These tests mock all external dependencies (DB, Redis, RabbitMQ)
 * so they run without Docker. We test the full HTTP layer behavior.
 *
 * For true integration tests (real DB), you'd use a test database.
 * The pattern here demonstrates how to structure tests properly.
 */

const request = require('supertest');

// ── Mock all external dependencies before loading the app ──────────────────

jest.mock('../../src/database/connection', () => ({
  query: jest.fn(),
  withTransaction: jest.fn((fn) => fn({
    query: jest.fn().mockResolvedValue({ rows: [] }),
  })),
  checkHealth: jest.fn().mockResolvedValue(true),
  close: jest.fn(),
}));

jest.mock('../../src/locks/redisLock', () => ({
  withLock: jest.fn((key, ttl, fn) => fn()),
  acquireLock: jest.fn().mockResolvedValue('lock-value'),
  releaseLock: jest.fn(),
  checkHealth: jest.fn().mockResolvedValue(true),
  close: jest.fn(),
}));

jest.mock('../../src/messaging/rabbitmq', () => ({
  connect: jest.fn(),
  publishPaymentProcess: jest.fn().mockResolvedValue(undefined),
  publishPaymentRetry: jest.fn().mockResolvedValue(undefined),
  checkHealth: jest.fn().mockResolvedValue(true),
  close: jest.fn(),
}));

// ── Load app AFTER mocks are in place ──────────────────────────────────────
const app = require('../../src/server');
const paymentRepo = require('../../src/repositories/paymentRepository');
const eventRepo = require('../../src/repositories/eventRepository');

jest.mock('../../src/repositories/paymentRepository');
jest.mock('../../src/repositories/eventRepository');
jest.mock('../../src/audit/auditService', () => ({
  record: jest.fn().mockResolvedValue({}),
  AUDIT_EVENTS: {
    PAYMENT_CREATED: 'PAYMENT_CREATED',
    PAYMENT_PROCESSING_STARTED: 'PAYMENT_PROCESSING_STARTED',
  },
}));

// ── Test data ─────────────────────────────────────────────────────────────────

const mockPayment = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  amount: 100.50,
  status: 'PENDING',
  externalStatus: 'PENDING',
  idempotencyKey: 'test-key-123',
  retryCount: 0,
  maxRetries: 3,
  lastError: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

// ── Test Suites ───────────────────────────────────────────────────────────────

describe('POST /payments', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('creates a new payment and returns 201', async () => {
    paymentRepo.findByIdempotencyKey.mockResolvedValue(null);
    paymentRepo.create.mockResolvedValue(mockPayment);

    const res = await request(app)
      .post('/payments')
      .send({ amount: 100.50, idempotencyKey: 'test-key-123' });

    expect(res.status).toBe(201);
    expect(res.body.data.id).toBe(mockPayment.id);
    expect(res.body.data.amount).toBe(100.50);
    expect(res.body.data.status).toBe('PENDING');
  });

  test('returns 200 for duplicate idempotency key (existing payment)', async () => {
    paymentRepo.findByIdempotencyKey.mockResolvedValue(mockPayment);

    const res = await request(app)
      .post('/payments')
      .send({ amount: 100.50, idempotencyKey: 'test-key-123' });

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(mockPayment.id);
    // Should NOT have called create
    expect(paymentRepo.create).not.toHaveBeenCalled();
  });

  test('returns 422 when amount is missing', async () => {
    const res = await request(app)
      .post('/payments')
      .send({ idempotencyKey: 'test-key-123' });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Validation failed');
  });

  test('returns 422 when amount is negative', async () => {
    const res = await request(app)
      .post('/payments')
      .send({ amount: -50, idempotencyKey: 'test-key-123' });

    expect(res.status).toBe(422);
  });

  test('returns 422 when idempotencyKey is missing', async () => {
    const res = await request(app)
      .post('/payments')
      .send({ amount: 100.50 });

    expect(res.status).toBe(422);
  });

  test('returns 422 when idempotencyKey is empty string', async () => {
    const res = await request(app)
      .post('/payments')
      .send({ amount: 100.50, idempotencyKey: '' });

    expect(res.status).toBe(422);
  });
});

describe('GET /payments', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns list of payments', async () => {
    paymentRepo.findAll.mockResolvedValue([mockPayment]);

    const res = await request(app).get('/payments');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.count).toBe(1);
  });

  test('passes status filter to repository', async () => {
    paymentRepo.findAll.mockResolvedValue([]);

    await request(app).get('/payments?status=SUCCESS');

    expect(paymentRepo.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'SUCCESS' })
    );
  });

  test('returns 422 for invalid status filter', async () => {
    const res = await request(app).get('/payments?status=INVALID');
    expect(res.status).toBe(422);
  });
});

describe('GET /payments/:id', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns payment by ID', async () => {
    paymentRepo.findById.mockResolvedValue(mockPayment);

    const res = await request(app).get(`/payments/${mockPayment.id}`);

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(mockPayment.id);
  });

  test('returns 404 when payment not found', async () => {
    paymentRepo.findById.mockResolvedValue(null);

    const res = await request(app).get(`/payments/${mockPayment.id}`);

    expect(res.status).toBe(404);
  });

  test('returns 422 for invalid UUID', async () => {
    const res = await request(app).get('/payments/not-a-uuid');
    expect(res.status).toBe(422);
  });
});

describe('GET /payments/:id/events', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns payment event timeline', async () => {
    paymentRepo.findById.mockResolvedValue(mockPayment);
    eventRepo.findByPaymentId.mockResolvedValue([
      { id: 'evt-1', paymentId: mockPayment.id, eventType: 'PAYMENT_CREATED', metadata: {}, createdAt: new Date().toISOString() },
    ]);

    const res = await request(app).get(`/payments/${mockPayment.id}/events`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].eventType).toBe('PAYMENT_CREATED');
  });
});

describe('GET /health', () => {
  test('returns 200 ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});
