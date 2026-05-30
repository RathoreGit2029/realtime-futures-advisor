import Fastify from 'fastify';
import cors from '@fastify/cors';
import { db } from './db/index.js';
import { advisorSignals } from './db/schema.js';
import { eq, desc, lt, and, or, sql } from 'drizzle-orm';

const fastify = Fastify({ logger: true });

fastify.register(cors, { origin: '*' });

fastify.get('/health', async () => ({
  service: 'realtime-advisor-backend',
  status: 'OK',
  timestamp: new Date().toISOString()
}));

fastify.get('/api/advisor/signals', async (_req, reply) => {
  try {
    return await db.select().from(advisorSignals).orderBy(desc(advisorSignals.createdAt));
  } catch (err) {
    fastify.log.error(err);
    reply.status(500).send({ error: 'Failed to retrieve advisor signals' });
  }
});

fastify.post('/api/advisor/signals', async (req: any, reply) => {
  try {
    const s = req.body;
    const target1 = s.target1 ?? s.entryPrice;
    const target2 = s.target2 ?? target1;

    try {
      const [signal] = await db.insert(advisorSignals).values({
        symbol: s.symbol,
        direction: s.direction,
        entryPrice: String(s.entryPrice),
        stopLoss: String(s.stopLoss),
        target1: String(target1),
        target2: String(target2),
        positionSize: String(s.positionSize),
        marginRequired: String(s.marginRequired),
        leverage: Number(s.leverage),
        riskAmount: String(s.riskAmount),
        probability: Number(s.probability),
        patternName: s.patternName,
        rsiValue: s.rsiValue != null ? Number(s.rsiValue) : null,
        ema9: s.ema9 != null ? String(s.ema9) : null,
        ema21: s.ema21 != null ? String(s.ema21) : null,
        bullishObCount: s.bullishObCount != null ? Number(s.bullishObCount) : null,
        bearishObCount: s.bearishObCount != null ? Number(s.bearishObCount) : null,
        confidenceTrend: s.confidenceTrend != null ? Number(s.confidenceTrend) : null,
        confidenceSmc: s.confidenceSmc != null ? Number(s.confidenceSmc) : null,
        confidenceMomentum: s.confidenceMomentum != null ? Number(s.confidenceMomentum) : null,
        status: s.status || 'ACTIVE',
        hypotheticalOutcome: s.status || 'ACTIVE',
        actualOutcome: s.actualOutcome || null,
        triggerCatalyst: s.triggerCatalyst || '',
        timeframe: s.timeframe
      }).returning();
      return signal;
    } catch (dbErr: any) {
      if (dbErr.code === '23505') {
        const existing = await db.select()
          .from(advisorSignals)
          .where(
            and(
              eq(advisorSignals.symbol, s.symbol),
              or(
                eq(advisorSignals.status, 'ACTIVE'),
                eq(advisorSignals.status, 'SANDBOX_ACTIVE')
              )
            )
          );
        if (existing.length > 0) return existing[0];
      }
      throw dbErr;
    }
  } catch (err) {
    fastify.log.error(err);
    reply.status(500).send({ error: 'Failed to create advisor signal' });
  }
});

fastify.post('/api/advisor/signals/:id/action', async (req: any, reply) => {
  try {
    const { id } = req.params;
    const [updated] = await db.update(advisorSignals)
      .set({ actionTaken: true })
      .where(eq(advisorSignals.id, id))
      .returning();
    return updated;
  } catch (err) {
    fastify.log.error(err);
    reply.status(500).send({ error: 'Failed to mark action taken' });
  }
});

fastify.post('/api/advisor/alerts', async (req: any, reply) => {
  try {
    const { phone, message } = req.body;
    fastify.log.info({ phone, message }, 'Advisor alert (console gateway)');
    return { success: true, message: 'Alert logged on server' };
  } catch (err) {
    fastify.log.error(err);
    reply.status(500).send({ error: 'Failed to dispatch alert' });
  }
});

fastify.delete('/api/advisor/signals/sandbox', async (_req, reply) => {
  try {
    const deleted = await db.delete(advisorSignals)
      .where(eq(advisorSignals.actualOutcome, 'SANDBOX'))
      .returning();
    return { success: true, count: deleted.length };
  } catch (err) {
    fastify.log.error(err);
    reply.status(500).send({ error: 'Failed to purge sandbox signals' });
  }
});

fastify.put('/api/advisor/signals/:id', async (req: any, reply) => {
  try {
    const { id } = req.params;
    const { status, pnlPercentage, elapsedCandles } = req.body;

    const updated = await db.transaction(async (tx) => {
      const current = await tx.select()
        .from(advisorSignals)
        .where(eq(advisorSignals.id, id))
        .for('update');

      const signal = current[0];
      if (!signal) return null;

      if (signal.status !== 'ACTIVE' && signal.status !== 'SANDBOX_ACTIVE') {
        return signal;
      }

      const wasTaken = signal.actionTaken ?? false;
      const isSandbox =
        signal.actualOutcome === 'SANDBOX' ||
        (typeof status === 'string' && status.startsWith('SANDBOX_'));

      const [res] = await tx.update(advisorSignals)
        .set({
          status,
          hypotheticalOutcome: status,
          actualOutcome: isSandbox ? 'SANDBOX' : (wasTaken ? status : null),
          pnlPercentage: String(pnlPercentage ?? '0.0000'),
          elapsedCandles: Number(elapsedCandles ?? 0),
          resolvedAt: new Date()
        })
        .where(eq(advisorSignals.id, id))
        .returning();

      return res;
    });

    if (!updated) {
      reply.status(404).send({ error: 'Signal not found' });
      return;
    }

    return updated;
  } catch (err) {
    fastify.log.error(err);
    reply.status(500).send({ error: 'Failed to update advisor signal' });
  }
});

const startCleanupWorker = () => {
  const PURGE_INTERVAL = 60 * 60 * 1000;

  setInterval(async () => {
    try {
      const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
      const deletedSignals = await db.delete(advisorSignals)
        .where(lt(advisorSignals.createdAt, cutoff))
        .returning();
      fastify.log.info(`Retention purge: ${deletedSignals.length} advisor signals removed`);
    } catch (err) {
      fastify.log.error(err, 'Retention purge failed');
    }
  }, PURGE_INTERVAL);
};

const start = async () => {
  try {
    await db.execute(sql`
      UPDATE advisor_signals
      SET status = CASE WHEN status = 'SANDBOX_ACTIVE' THEN 'SANDBOX_TIMEOUT' ELSE 'TIMEOUT' END,
          resolved_at = NOW()
      WHERE status IN ('ACTIVE', 'SANDBOX_ACTIVE')
    `);

    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS unique_active_symbol
      ON advisor_signals (symbol)
      WHERE status IN ('ACTIVE', 'SANDBOX_ACTIVE')
    `);

    const port = Number(process.env.PORT) || 4000;
    await fastify.listen({ port, host: '0.0.0.0' });
    fastify.log.info(`Realtime Advisor API listening on port ${port}`);
    startCleanupWorker();
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
