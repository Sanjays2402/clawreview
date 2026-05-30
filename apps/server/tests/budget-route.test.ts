import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { buildServer } = await import('../src/server.js');
const { _resetBudgetGuardForTests, getBudgetGuard } = await import('../src/budget.js');

describe('budget routes', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
  });
  afterAll(async () => app.close());
  beforeEach(() => _resetBudgetGuardForTests());

  it('returns a zero snapshot for an unseen installation', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/budget/123' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.installationId).toBe(123);
    expect(body.spentUsd).toBe(0);
    expect(body.remainingUsd).toBe(body.limitUsd);
    expect(body.overLimit).toBe(false);
  });

  it('reflects spend after the guard is updated', async () => {
    const g = getBudgetGuard(50);
    g.spent(7, 12.5);
    const res = await app.inject({ method: 'GET', url: '/api/budget/7' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.spentUsd).toBe(12.5);
    expect(body.remainingUsd).toBe(37.5);
  });

  it('PUT updates the limit', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/budget/9',
      payload: { limitUsd: 200 },
    });
    expect(put.statusCode).toBe(200);
    const snap = await app.inject({ method: 'GET', url: '/api/budget/9' });
    expect(snap.json().limitUsd).toBe(200);
  });

  it('POST /reset clears state', async () => {
    const g = getBudgetGuard(50);
    g.spent(11, 49);
    expect(g.overLimit(11)).toBe(false);
    g.spent(11, 5);
    expect(g.overLimit(11)).toBe(true);
    const res = await app.inject({ method: 'POST', url: '/api/budget/11/reset' });
    expect(res.statusCode).toBe(200);
    expect(g.overLimit(11)).toBe(false);
  });

  it('rejects bad installationId', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/budget/not-a-number' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects PUT with non-positive limit', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/budget/1',
      payload: { limitUsd: -1 },
    });
    expect(res.statusCode).toBe(400);
  });
});
