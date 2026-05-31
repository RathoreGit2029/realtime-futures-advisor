"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fastify_1 = __importDefault(require("fastify"));
const cors_1 = __importDefault(require("@fastify/cors"));
const websocket_1 = __importDefault(require("@fastify/websocket"));
const index_js_1 = require("./db/index.js");
const schema_js_1 = require("./db/schema.js");
const drizzle_orm_1 = require("drizzle-orm");
const BinanceWebSocketManager_js_1 = require("./engine/BinanceWebSocketManager.js");
const fastify = (0, fastify_1.default)({ logger: true });
fastify.register(cors_1.default, { origin: '*' });
fastify.register(websocket_1.default);
// Initialize execution manager
const manager = BinanceWebSocketManager_js_1.BinanceWebSocketManager.getInstance();
manager.init();
// WebSocket real-time client route
fastify.register(async function (fastify) {
    fastify.get('/ws', { websocket: true }, (connection, req) => {
        console.log('🔌 Extension client connected to backend WebSocket.');
        manager.registerClient(connection.socket);
        connection.socket.on('message', (message) => {
            try {
                const msg = JSON.parse(message);
                if (msg.type === 'SUBSCRIBE_SYMBOLS') {
                    const symbols = msg.symbols || [];
                    console.log(`🔌 Client subscribed to symbols: ${symbols.join(', ')}`);
                    for (const sym of symbols) {
                        manager.subscribe(sym, connection.socket, (data) => {
                            connection.socket.send(JSON.stringify(data));
                        });
                    }
                }
                else if (msg.type === 'UPDATE_SETTINGS') {
                    manager.updateSettings(msg.settings);
                }
            }
            catch (e) {
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
fastify.get('/api/advisor/events', async (req, reply) => {
    try {
        const fromSequence = Number(req.query.fromSequence || 0);
        const events = await index_js_1.db.select()
            .from(schema_js_1.advisorEvents)
            .where((0, drizzle_orm_1.sql) `${schema_js_1.advisorEvents.sequenceNumber} >= ${fromSequence}`)
            .orderBy(schema_js_1.advisorEvents.sequenceNumber)
            .execute();
        const parsedEvents = events.map((e) => ({
            sequenceNumber: e.sequenceNumber,
            exchangeTimestamp: e.exchangeTimestamp,
            receiveTimestamp: e.receiveTimestamp,
            eventId: e.eventId,
            correlationId: e.correlationId,
            type: e.type,
            payload: JSON.parse(e.payload),
            marketContextSnapshot: e.marketContextSnapshot ? JSON.parse(e.marketContextSnapshot) : undefined,
            decisionMetadata: e.decisionMetadata ? JSON.parse(e.decisionMetadata) : undefined,
            eventVersion: e.eventVersion,
            previousEventHash: e.previousEventHash || undefined,
            deterministicHash: e.deterministicHash
        }));
        return parsedEvents;
    }
    catch (err) {
        fastify.log.error(err);
        reply.status(500).send({ error: 'Failed to retrieve event logs' });
    }
});
fastify.post('/api/advisor/events', async (req, reply) => {
    try {
        const event = req.body;
        if (!event || typeof event.sequenceNumber !== 'number') {
            return reply.status(400).send({ error: 'Invalid event format' });
        }
        const result = await index_js_1.db.transaction(async (tx) => {
            // Sequence checking gate
            const maxSeqRes = await tx.select({ maxSeq: (0, drizzle_orm_1.sql) `MAX(${schema_js_1.advisorEvents.sequenceNumber})` })
                .from(schema_js_1.advisorEvents)
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
                const lastEvent = await tx.select({ deterministicHash: schema_js_1.advisorEvents.deterministicHash })
                    .from(schema_js_1.advisorEvents)
                    .where((0, drizzle_orm_1.eq)(schema_js_1.advisorEvents.sequenceNumber, maxSeq))
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
            await tx.insert(schema_js_1.advisorEvents).values({
                sequenceNumber: event.sequenceNumber,
                exchangeTimestamp: event.exchangeTimestamp,
                receiveTimestamp: event.receiveTimestamp,
                eventId: event.eventId,
                correlationId: event.correlationId,
                type: event.type,
                payload: JSON.stringify(event.payload),
                marketContextSnapshot: event.marketContextSnapshot ? JSON.stringify(event.marketContextSnapshot) : null,
                decisionMetadata: event.decisionMetadata ? JSON.stringify(event.decisionMetadata) : null,
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
    }
    catch (err) {
        fastify.log.error(err);
        reply.status(500).send({ error: 'Failed to append event to PostgreSQL store' });
    }
});
fastify.post('/api/advisor/snapshots', async (req, reply) => {
    try {
        const { sequenceNumber, stateData, timestamp } = req.body;
        if (typeof sequenceNumber !== 'number' || !stateData) {
            return reply.status(400).send({ error: 'Invalid snapshot format' });
        }
        await index_js_1.db.insert(schema_js_1.advisorSnapshots)
            .values({
            sequenceNumber,
            stateData: JSON.stringify(stateData),
            timestamp: timestamp || Date.now()
        })
            .onConflictDoUpdate({
            target: schema_js_1.advisorSnapshots.sequenceNumber,
            set: {
                stateData: JSON.stringify(stateData),
                timestamp: timestamp || Date.now()
            }
        })
            .execute();
        return { success: true, sequenceNumber };
    }
    catch (err) {
        fastify.log.error(err);
        reply.status(500).send({ error: 'Failed to store snapshot checkpoint' });
    }
});
fastify.get('/api/advisor/snapshots/latest', async (_req, reply) => {
    try {
        const snapshots = await index_js_1.db.select()
            .from(schema_js_1.advisorSnapshots)
            .orderBy((0, drizzle_orm_1.desc)(schema_js_1.advisorSnapshots.sequenceNumber))
            .limit(1)
            .execute();
        const snapshot = snapshots[0];
        if (!snapshot) {
            return null;
        }
        return {
            sequenceNumber: snapshot.sequenceNumber,
            stateData: JSON.parse(snapshot.stateData),
            timestamp: snapshot.timestamp
        };
    }
    catch (err) {
        fastify.log.error(err);
        reply.status(500).send({ error: 'Failed to retrieve latest snapshot' });
    }
});
fastify.get('/api/advisor/signals', async (_req, reply) => {
    try {
        return await index_js_1.db.select().from(schema_js_1.advisorSignals).orderBy((0, drizzle_orm_1.desc)(schema_js_1.advisorSignals.createdAt));
    }
    catch (err) {
        fastify.log.error(err);
        reply.status(500).send({ error: 'Failed to retrieve advisor signals' });
    }
});
fastify.post('/api/advisor/signals', async (req, reply) => {
    try {
        const s = req.body;
        const primaryTarget = s.primaryTarget ?? s.target1 ?? s.entryPrice;
        const secondaryTarget = s.secondaryTarget ?? s.target2 ?? null;
        try {
            const [signal] = await index_js_1.db.insert(schema_js_1.advisorSignals).values({
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
        }
        catch (dbErr) {
            if (dbErr.code === '23505') {
                const existing = await index_js_1.db.select()
                    .from(schema_js_1.advisorSignals)
                    .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.advisorSignals.symbol, s.symbol), (0, drizzle_orm_1.or)((0, drizzle_orm_1.eq)(schema_js_1.advisorSignals.status, 'ACTIVE'), (0, drizzle_orm_1.eq)(schema_js_1.advisorSignals.status, 'SANDBOX_ACTIVE'))));
                if (existing.length > 0)
                    return existing[0];
            }
            throw dbErr;
        }
    }
    catch (err) {
        fastify.log.error(err);
        reply.status(500).send({ error: 'Failed to create advisor signal' });
    }
});
fastify.post('/api/advisor/signals/:id/action', async (req, reply) => {
    try {
        const { id } = req.params;
        const [updated] = await index_js_1.db.update(schema_js_1.advisorSignals)
            .set({ actionTaken: true })
            .where((0, drizzle_orm_1.eq)(schema_js_1.advisorSignals.id, id))
            .returning();
        return updated;
    }
    catch (err) {
        fastify.log.error(err);
        reply.status(500).send({ error: 'Failed to mark action taken' });
    }
});
fastify.post('/api/advisor/alerts', async (req, reply) => {
    try {
        const { phone, message } = req.body;
        fastify.log.info({ phone, message }, 'Advisor alert (console gateway)');
        return { success: true, message: 'Alert logged on server' };
    }
    catch (err) {
        fastify.log.error(err);
        reply.status(500).send({ error: 'Failed to dispatch alert' });
    }
});
fastify.delete('/api/advisor/signals/sandbox', async (_req, reply) => {
    try {
        const deleted = await index_js_1.db.delete(schema_js_1.advisorSignals)
            .where((0, drizzle_orm_1.eq)(schema_js_1.advisorSignals.actualOutcome, 'SANDBOX'))
            .returning();
        return { success: true, count: deleted.length };
    }
    catch (err) {
        fastify.log.error(err);
        reply.status(500).send({ error: 'Failed to purge sandbox signals' });
    }
});
fastify.put('/api/advisor/signals/:id', async (req, reply) => {
    try {
        const { id } = req.params;
        const { status, pnlPercentage, elapsedCandles } = req.body;
        const updated = await index_js_1.db.transaction(async (tx) => {
            const current = await tx.select()
                .from(schema_js_1.advisorSignals)
                .where((0, drizzle_orm_1.eq)(schema_js_1.advisorSignals.id, id))
                .for('update');
            const signal = current[0];
            if (!signal)
                return null;
            if (signal.status !== 'ACTIVE' && signal.status !== 'SANDBOX_ACTIVE') {
                return signal;
            }
            const wasTaken = signal.actionTaken ?? false;
            const isSandbox = signal.actualOutcome === 'SANDBOX' ||
                (typeof status === 'string' && status.startsWith('SANDBOX_'));
            const [res] = await tx.update(schema_js_1.advisorSignals)
                .set({
                status,
                hypotheticalOutcome: status,
                actualOutcome: isSandbox ? 'SANDBOX' : (wasTaken ? status : null),
                pnlPercentage: String(pnlPercentage ?? '0.0000'),
                elapsedCandles: Number(elapsedCandles ?? 0),
                resolvedAt: new Date()
            })
                .where((0, drizzle_orm_1.eq)(schema_js_1.advisorSignals.id, id))
                .returning();
            return res;
        });
        if (!updated) {
            reply.status(404).send({ error: 'Signal not found' });
            return;
        }
        return updated;
    }
    catch (err) {
        fastify.log.error(err);
        reply.status(500).send({ error: 'Failed to update advisor signal' });
    }
});
const startCleanupWorker = () => {
    const PURGE_INTERVAL = 60 * 60 * 1000;
    setInterval(async () => {
        try {
            const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
            const deletedSignals = await index_js_1.db.delete(schema_js_1.advisorSignals)
                .where((0, drizzle_orm_1.lt)(schema_js_1.advisorSignals.createdAt, cutoff))
                .returning();
            fastify.log.info(`Retention purge: ${deletedSignals.length} advisor signals removed`);
        }
        catch (err) {
            fastify.log.error(err, 'Retention purge failed');
        }
    }, PURGE_INTERVAL);
};
const start = async () => {
    try {
        await index_js_1.db.execute((0, drizzle_orm_1.sql) `
      UPDATE advisor_signals
      SET status = CASE WHEN status = 'SANDBOX_ACTIVE' THEN 'SANDBOX_TIMEOUT' ELSE 'TIMEOUT' END,
          resolved_at = NOW()
      WHERE status IN ('ACTIVE', 'SANDBOX_ACTIVE')
    `);
        await index_js_1.db.execute((0, drizzle_orm_1.sql) `
      CREATE UNIQUE INDEX IF NOT EXISTS unique_active_symbol
      ON advisor_signals (symbol)
      WHERE status IN ('ACTIVE', 'SANDBOX_ACTIVE')
    `);
        const port = Number(process.env.PORT) || 4000;
        await fastify.listen({ port, host: '0.0.0.0' });
        fastify.log.info(`Realtime Advisor API listening on port ${port}`);
        startCleanupWorker();
    }
    catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};
start();
