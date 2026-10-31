import type { Request, Response } from 'express';
import { createPlatformInvoiceHandler } from './invoices';

const response = () => {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
};

const statement = { month: '2026-10', from: 'a', to: 'b', tenants: [] };

describe('platform invoices handler', () => {
  it('answers the month with the display currency', async () => {
    const getPlatformInvoices = jest.fn().mockResolvedValue(statement);
    const handler = createPlatformInvoiceHandler({
      getPlatformInvoices,
      currency: () => ({ code: 'EUR', rate: 0.92 }),
    });
    const res = response();

    await handler(
      { query: { month: '2026-10' } } as unknown as Request,
      res as unknown as Response,
    );

    expect(getPlatformInvoices).toHaveBeenCalledWith({ month: '2026-10' });
    expect(res.json).toHaveBeenCalledWith({ ...statement, currency: { code: 'EUR', rate: 0.92 } });
  });

  it('takes the current month without one and refuses anything else', async () => {
    const getPlatformInvoices = jest.fn().mockResolvedValue(statement);
    const handler = createPlatformInvoiceHandler({
      getPlatformInvoices,
      currency: () => undefined,
    });

    await handler({ query: {} } as unknown as Request, response() as unknown as Response);
    expect(getPlatformInvoices).toHaveBeenCalledWith({
      month: new Date().toISOString().slice(0, 7),
    });

    for (const month of ['2026-13', '26-10', ['2026-10']]) {
      const res = response();
      await handler({ query: { month } } as unknown as Request, res as unknown as Response);
      expect(res.status).toHaveBeenCalledWith(400);
    }
  });

  it('hides a failure behind a generic error', async () => {
    const handler = createPlatformInvoiceHandler({
      getPlatformInvoices: jest.fn().mockRejectedValue(new Error('connection string leaked')),
      currency: () => undefined,
    });
    const res = response();
    await handler(
      { query: { month: '2026-10' } } as unknown as Request,
      res as unknown as Response,
    );
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'internal_error' });
  });
});
