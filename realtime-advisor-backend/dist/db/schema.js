"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.advisorSignals = void 0;
const pg_core_1 = require("drizzle-orm/pg-core");
/** Signals persisted from the Binance Futures Real-Time Advisor Chrome extension. */
exports.advisorSignals = (0, pg_core_1.pgTable)('advisor_signals', {
    id: (0, pg_core_1.uuid)('id').defaultRandom().primaryKey(),
    symbol: (0, pg_core_1.varchar)('symbol', { length: 15 }).notNull(),
    direction: (0, pg_core_1.varchar)('direction', { length: 5 }).notNull(), // LONG / SHORT
    entryPrice: (0, pg_core_1.decimal)('entry_price', { precision: 18, scale: 8 }).notNull(),
    stopLoss: (0, pg_core_1.decimal)('stop_loss', { precision: 18, scale: 8 }).notNull(),
    primaryTarget: (0, pg_core_1.decimal)('primary_target', { precision: 18, scale: 8 }).notNull(),
    secondaryTarget: (0, pg_core_1.decimal)('secondary_target', { precision: 18, scale: 8 }),
    positionSize: (0, pg_core_1.decimal)('position_size', { precision: 18, scale: 8 }).notNull(),
    marginRequired: (0, pg_core_1.decimal)('margin_required', { precision: 18, scale: 8 }).notNull(),
    leverage: (0, pg_core_1.integer)('leverage').notNull(),
    riskAmount: (0, pg_core_1.decimal)('risk_amount', { precision: 18, scale: 8 }).notNull(),
    probability: (0, pg_core_1.integer)('probability').notNull(),
    patternName: (0, pg_core_1.varchar)('pattern_name', { length: 50 }).notNull(),
    displacementScore: (0, pg_core_1.integer)('displacement_score'),
    sweptPoolType: (0, pg_core_1.varchar)('swept_pool_type', { length: 50 }),
    sweptPoolPrice: (0, pg_core_1.decimal)('swept_pool_price', { precision: 18, scale: 8 }),
    mssPrice: (0, pg_core_1.decimal)('mss_price', { precision: 18, scale: 8 }),
    fvgTop: (0, pg_core_1.decimal)('fvg_top', { precision: 18, scale: 8 }),
    fvgBottom: (0, pg_core_1.decimal)('fvg_bottom', { precision: 18, scale: 8 }),
    dealingRangeHigh: (0, pg_core_1.decimal)('dealing_range_high', { precision: 18, scale: 8 }),
    dealingRangeLow: (0, pg_core_1.decimal)('dealing_range_low', { precision: 18, scale: 8 }),
    equilibrium: (0, pg_core_1.decimal)('equilibrium', { precision: 18, scale: 8 }),
    status: (0, pg_core_1.varchar)('status', { length: 15 }).default('ACTIVE'), // ACTIVE / WIN / LOSS / TIMEOUT / INVALIDATED
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
