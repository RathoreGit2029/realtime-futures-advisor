import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyWebsocket from '@fastify/websocket';
import { db } from './db/index.js';
import { advisorSignals, advisorEvents, advisorSnapshots } from './db/schema.js';
import { eq, desc, lt, and, or, sql } from 'drizzle-orm';
import { BinanceWebSocketManager } from './engine/BinanceWebSocketManager.js';

const fastify = Fastify({ logger: true });

fastify.register(cors, { origin: '*' });
fastify.register(fastifyWebsocket);

// Initialize execution manager
const manager = BinanceWebSocketManager.getInstance();
manager.init();

// WebSocket real-time client route
fastify.register(async function (fastify) {
  fastify.get('/ws', { websocket: true }, (connection: any, req: any) => {
    console.log('🔌 Extension client connected to backend WebSocket.');
    manager.registerClient(connection.socket);

    connection.socket.on('message', (message: string) => {
      try {
        const msg = JSON.parse(message);
        if (msg.type === 'SUBSCRIBE_SYMBOLS') {
          const symbols: string[] = msg.symbols || [];
          console.log(`🔌 Client subscribed to symbols: ${symbols.join(', ')}`);
          for (const sym of symbols) {
            manager.subscribe(sym, connection.socket, (data) => {
              connection.socket.send(JSON.stringify(data));
            });
          }
        } else if (msg.type === 'UPDATE_SETTINGS') {
          manager.updateSettings(msg.settings);
        }
      } catch (e) {
        console.error('Error handling websocket message:', e);
      }
    });

    connection.socket.on('close', () => {
      console.log('🔌 Extension client disconnected.');
      manager.unregisterClient(connection.socket);
    });
  });
});

fastify.get('/health', async () => ({
  service: 'realtime-advisor-backend',
  status: 'OK',
  timestamp: new Date().toISOString()
}));

// --- PostgreSQL Event Sourcing Endpoints ---

fastify.get('/api/advisor/events', async (req: any, reply) => {
  try {
    const fromSequence = Number(req.query.fromSequence || 0);
    const events = await db.select()
      .from(advisorEvents)
      .where(sql`${advisorEvents.sequenceNumber} >= ${fromSequence}`)
      .orderBy(advisorEvents.sequenceNumber)
      .execute();

    const parsedEvents = events.map((e: any) => ({
      sequenceNumber: e.sequenceNumber,
      exchangeTimestamp: e.exchangeTimestamp,
      receiveTimestamp: e.receiveTimestamp,
      eventId: e.eventId,
      correlationId: e.correlationId,
      type: e.type,
      payload: e.payload,
      marketContextSnapshot: e.marketContextSnapshot || undefined,
      decisionMetadata: e.decisionMetadata || undefined,
      eventVersion: e.eventVersion,
      previousEventHash: e.previousEventHash || undefined,
      deterministicHash: e.deterministicHash
    }));

    return parsedEvents;
  } catch (err) {
    fastify.log.error(err);
    reply.status(500).send({ error: 'Failed to retrieve event logs' });
  }
});

fastify.post('/api/advisor/events', async (req: any, reply) => {
  try {
    const event = req.body;
    if (!event || typeof event.sequenceNumber !== 'number') {
      return reply.status(400).send({ error: 'Invalid event format' });
    }

    const result = await db.transaction(async (tx) => {
      // Sequence checking gate
      const maxSeqRes = await tx.select({ maxSeq: sql`MAX(${advisorEvents.sequenceNumber})` })
        .from(advisorEvents)
        .execute();
      const maxSeq = maxSeqRes[0]?.maxSeq !== null && maxSeqRes[0]?.maxSeq !== undefined ? Number(maxSeqRes[0].maxSeq) : -1;

      const expectedSeq = maxSeq + 1;
      if (event.sequenceNumber !== expectedSeq) {
        return {
          errorStatus: 409,
          errorMsg: `Sequence mismatch. Expected: ${expectedSeq}, Received: ${event.sequenceNumber}`
        };
      }

      // Cryptographic hash continuity check
      if (maxSeq >= 0) {
        const lastEvent = await tx.select({ deterministicHash: advisorEvents.deterministicHash })
          .from(advisorEvents)
          .where(eq(advisorEvents.sequenceNumber, maxSeq))
          .execute();
        const lastHash = lastEvent[0]?.deterministicHash || '';

        if (event.previousEventHash !== lastHash) {
          return {
            errorStatus: 409,
            errorMsg: `Hash link broken. Expected previous hash: ${lastHash}, Received: ${event.previousEventHash}`
          };
        }
      }

      // Insert
      await tx.insert(advisorEvents).values({
        sequenceNumber: event.sequenceNumber,
        exchangeTimestamp: event.exchangeTimestamp,
        receiveTimestamp: event.receiveTimestamp,
        eventId: event.eventId,
        correlationId: event.correlationId,
        type: event.type,
        payload: event.payload,
        marketContextSnapshot: event.marketContextSnapshot || null,
        decisionMetadata: event.decisionMetadata || null,
        eventVersion: event.eventVersion,
        previousEventHash: event.previousEventHash || null,
        deterministicHash: event.deterministicHash
      }).execute();

      return { success: true };
    });

    if (result.errorStatus) {
      return reply.status(result.errorStatus).send({ error: result.errorMsg });
    }

    return { success: true, sequenceNumber: event.sequenceNumber };
  } catch (err) {
    fastify.log.error(err);
    reply.status(500).send({ error: 'Failed to append event to PostgreSQL store' });
  }
});

fastify.post('/api/advisor/snapshots', async (req: any, reply) => {
  try {
    const { sequenceNumber, stateData, timestamp } = req.body;
    if (typeof sequenceNumber !== 'number' || !stateData) {
      return reply.status(400).send({ error: 'Invalid snapshot format' });
    }

    await db.insert(advisorSnapshots)
      .values({
        sequenceNumber,
        stateData: stateData,
        timestamp: timestamp || Date.now()
      })
      .onConflictDoUpdate({
        target: advisorSnapshots.sequenceNumber,
        set: {
          stateData: stateData,
          timestamp: timestamp || Date.now()
        }
      })
      .execute();

    return { success: true, sequenceNumber };
  } catch (err) {
    fastify.log.error(err);
    reply.status(500).send({ error: 'Failed to store snapshot checkpoint' });
  }
});

fastify.get('/api/advisor/snapshots/latest', async (_req, reply) => {
  try {
    const snapshots = await db.select()
      .from(advisorSnapshots)
      .orderBy(desc(advisorSnapshots.sequenceNumber))
      .limit(1)
      .execute();

    const snapshot = snapshots[0];
    if (!snapshot) {
      return null;
    }

    return {
      sequenceNumber: snapshot.sequenceNumber,
      stateData: snapshot.stateData,
      timestamp: snapshot.timestamp
    };
  } catch (err) {
    fastify.log.error(err);
    reply.status(500).send({ error: 'Failed to retrieve latest snapshot' });
  }
});

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
    const primaryTarget = s.primaryTarget ?? s.target1 ?? s.entryPrice;
    const secondaryTarget = s.secondaryTarget ?? s.target2 ?? null;

    try {
      const [signal] = await db.insert(advisorSignals).values({
        symbol: s.symbol,
        direction: s.direction,
        entryPrice: String(s.entryPrice),
        stopLoss: String(s.stopLoss),
        primaryTarget: String(primaryTarget),
        secondaryTarget: secondaryTarget != null ? String(secondaryTarget) : null,
        positionSize: String(s.positionSize),
        marginRequired: String(s.marginRequired),
        leverage: Number(s.leverage),
        riskAmount: String(s.riskAmount),
        probability: Number(s.probability),
        patternName: s.patternName,
        displacementScore: s.displacementScore != null ? Number(s.displacementScore) : null,
        sweptPoolType: s.sweptPoolType || null,
        sweptPoolPrice: s.sweptPoolPrice != null ? String(s.sweptPoolPrice) : null,
        mssPrice: s.mssPrice != null ? String(s.mssPrice) : null,
        fvgTop: s.fvgTop != null ? String(s.fvgTop) : null,
        fvgBottom: s.fvgBottom != null ? String(s.fvgBottom) : null,
        dealingRangeHigh: s.dealingRangeHigh != null ? String(s.dealingRangeHigh) : null,
        dealingRangeLow: s.dealingRangeLow != null ? String(s.dealingRangeLow) : null,
        equilibrium: s.equilibrium != null ? String(s.equilibrium) : null,
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
