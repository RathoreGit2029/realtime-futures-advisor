import { pgTable, uuid, varchar, integer, decimal, timestamp, boolean } from 'drizzle-orm/pg-core';

/** Signals persisted from the Binance Futures Real-Time Advisor Chrome extension. */
export const advisorSignals = pgTable('advisor_signals', {
  id: uuid('id').defaultRandom().primaryKey(),
  symbol: varchar('symbol', { length: 15 }).notNull(),
  direction: varchar('direction', { length: 5 }).notNull(), // LONG / SHORT
  entryPrice: decimal('entry_price', { precision: 18, scale: 8 }).notNull(),
  stopLoss: decimal('stop_loss', { precision: 18, scale: 8 }).notNull(),
  primaryTarget: decimal('primary_target', { precision: 18, scale: 8 }).notNull(),
  secondaryTarget: decimal('secondary_target', { precision: 18, scale: 8 }),
  positionSize: decimal('position_size', { precision: 18, scale: 8 }).notNull(),
  marginRequired: decimal('margin_required', { precision: 18, scale: 8 }).notNull(),
  leverage: integer('leverage').notNull(),
  riskAmount: decimal('risk_amount', { precision: 18, scale: 8 }).notNull(),
  probability: integer('probability').notNull(),
  patternName: varchar('pattern_name', { length: 50 }).notNull(),
  displacementScore: integer('displacement_score'),
  sweptPoolType: varchar('swept_pool_type', { length: 50 }),
  sweptPoolPrice: decimal('swept_pool_price', { precision: 18, scale: 8 }),
  mssPrice: decimal('mss_price', { precision: 18, scale: 8 }),
  fvgTop: decimal('fvg_top', { precision: 18, scale: 8 }),
  fvgBottom: decimal('fvg_bottom', { precision: 18, scale: 8 }),
  dealingRangeHigh: decimal('dealing_range_high', { precision: 18, scale: 8 }),
  dealingRangeLow: decimal('dealing_range_low', { precision: 18, scale: 8 }),
  equilibrium: decimal('equilibrium', { precision: 18, scale: 8 }),
  status: varchar('status', { length: 15 }).default('ACTIVE'), // ACTIVE / WIN / LOSS / TIMEOUT / INVALIDATED
  pnlPercentage: decimal('pnl_percentage', { precision: 10, scale: 4 }).default('0.0000'),
  elapsedCandles: integer('elapsed_candles').default(0),
  timeframe: varchar('timeframe', { length: 5 }).notNull(),
  actionTaken: boolean('action_taken').default(false),
  hypotheticalOutcome: varchar('hypothetical_outcome', { length: 15 }).default('ACTIVE'),
  actualOutcome: varchar('actual_outcome', { length: 15 }),
  triggerCatalyst: varchar('trigger_catalyst', { length: 2000 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true })
});
