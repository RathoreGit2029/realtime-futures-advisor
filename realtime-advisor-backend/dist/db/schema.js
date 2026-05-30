"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.advisorSignals = void 0;
const pg_core_1 = require("drizzle-orm/pg-core");
/** Signals persisted from the Binance Futures Real-Time Advisor Chrome extension. */
exports.advisorSignals = (0, pg_core_1.pgTable)('advisor_signals', {
    id: (0, pg_core_1.uuid)('id').defaultRandom().primaryKey(),
    symbol: (0, pg_core_1.varchar)('symbol', { length: 15 }).notNull(),
    direction: (0, pg_core_1.varchar)('direction', { length: 5 }).notNull(),
    entryPrice: (0, pg_core_1.decimal)('entry_price', { precision: 18, scale: 8 }).notNull(),
    stopLoss: (0, pg_core_1.decimal)('stop_loss', { precision: 18, scale: 8 }).notNull(),
    target1: (0, pg_core_1.decimal)('target_1', { precision: 18, scale: 8 }).notNull(),
    target2: (0, pg_core_1.decimal)('target_2', { precision: 18, scale: 8 }).notNull(),
    positionSize: (0, pg_core_1.decimal)('position_size', { precision: 18, scale: 8 }).notNull(),
    marginRequired: (0, pg_core_1.decimal)('margin_required', { precision: 18, scale: 8 }).notNull(),
    leverage: (0, pg_core_1.integer)('leverage').notNull(),
    riskAmount: (0, pg_core_1.decimal)('risk_amount', { precision: 18, scale: 8 }).notNull(),
    probability: (0, pg_core_1.integer)('probability').notNull(),
    patternName: (0, pg_core_1.varchar)('pattern_name', { length: 50 }).notNull(),
    rsiValue: (0, pg_core_1.integer)('rsi_value'),
    ema9: (0, pg_core_1.decimal)('ema_9', { precision: 18, scale: 8 }),
    ema21: (0, pg_core_1.decimal)('ema_21', { precision: 18, scale: 8 }),
    bullishObCount: (0, pg_core_1.integer)('bullish_ob_count'),
    bearishObCount: (0, pg_core_1.integer)('bearish_ob_count'),
    confidenceTrend: (0, pg_core_1.integer)('confidence_trend'),
    confidenceSmc: (0, pg_core_1.integer)('confidence_smc'),
    confidenceMomentum: (0, pg_core_1.integer)('confidence_momentum'),
    status: (0, pg_core_1.varchar)('status', { length: 15 }).default('ACTIVE'),
    pnlPercentage: (0, pg_core_1.decimal)('pnl_percentage', { precision: 10, scale: 4 }).default('0.0000'),
    elapsedCandles: (0, pg_core_1.integer)('elapsed_candles').default(0),
    timeframe: (0, pg_core_1.varchar)('timeframe', { length: 5 }).notNull(),
    actionTaken: (0, pg_core_1.boolean)('action_taken').default(false),
    hypotheticalOutcome: (0, pg_core_1.varchar)('hypothetical_outcome', { length: 15 }).default('ACTIVE'),
    actualOutcome: (0, pg_core_1.varchar)('actual_outcome', { length: 15 }),
    triggerCatalyst: (0, pg_core_1.varchar)('trigger_catalyst', { length: 2000 }),
    createdAt: (0, pg_core_1.timestamp)('created_at', { withTimezone: true }).defaultNow(),
    resolvedAt: (0, pg_core_1.timestamp)('resolved_at', { withTimezone: true })
});
