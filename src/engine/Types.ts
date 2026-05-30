export enum MarketState {
  ACCUMULATION = 'ACCUMULATION',
  LIQUIDITY_SWEEP = 'LIQUIDITY_SWEEP',
  DISPLACEMENT = 'DISPLACEMENT',
  RETRACEMENT = 'RETRACEMENT',
  EXECUTION_WINDOW = 'EXECUTION_WINDOW',
  ACTIVE_POSITION = 'ACTIVE_POSITION',
  EXIT = 'EXIT',
  NO_TRADE = 'NO_TRADE',
  EXPANSION = 'EXPANSION',
  REVERSAL = 'REVERSAL',
  CHOPPY = 'CHOPPY'
}

export enum MarketRegime {
  TRENDING = 'TRENDING',
  MEAN_REVERTING = 'MEAN_REVERTING',
  CHOPPY = 'CHOPPY',
  EXPANSION = 'EXPANSION',
  COMPRESSION = 'COMPRESSION',
  HIGH_VOLATILITY = 'HIGH_VOLATILITY',
  LOW_LIQUIDITY = 'LOW_LIQUIDITY',
  NEWS_EVENT = 'NEWS_EVENT',
  LIQUIDATION_CASCADE = 'LIQUIDATION_CASCADE'
}

export interface VolatilityState {
  atr: number;
  isExpanding: boolean;
  isCompressing: boolean;
  historicalRank: number; // 0-100 percentile
}

export interface LiquidityState {
  hasSweep: boolean;
  sweepQuality: number; // 0-100
  recentSweepDirection: 'BULLISH' | 'BEARISH' | null;
}

export interface TrendState {
  direction: 'UP' | 'DOWN' | 'SIDEWAYS';
  strength: number; // 0-100
  htfAlignment: boolean;
}

export interface SessionState {
  currentSession: 'ASIA' | 'LONDON' | 'NEW_YORK' | 'POST_NY_CHOP';
  isOverlap: boolean;
  minutesIntoSession: number;
}

/**
 * Fully assembled, immutable market context.
 * Created by the engine after regime classification and confidence assignment.
 * Never constructed directly by background.js — use RawMarketInput instead.
 */
export interface MarketContext {
  readonly timestamp: number;
  readonly sequenceNumber: number;
  readonly symbol: string;
  readonly regime: MarketRegime;
  readonly marketState: MarketState;
  readonly volatility: VolatilityState;
  readonly liquidityState: LiquidityState;
  readonly trendState: TrendState;
  readonly sessionState: SessionState;
  readonly displacementQuality: number;
  readonly spread: number;
  readonly orderbookDepth?: number;
  readonly confidence: number;
  readonly currentPrice: number;
  readonly positionActive?: boolean;
  readonly deterministicHash: string;
}

/**
 * Raw input from background.js.
 * regime is optional — the engine classifies it from the other fields.
 * confidence is a placeholder — the engine overwrites it with the Bayesian posterior.
 */
export interface RawMarketInput {
  timestamp: number;
  symbol: string;
  marketState: MarketState;
  volatility: VolatilityState;
  liquidityState: LiquidityState;
  trendState: TrendState;
  sessionState: SessionState;
  displacementQuality: number;
  spread: number;
  orderbookDepth?: number;
  confidence: number;
  currentPrice: number;
  sequenceNumber?: number;
  positionActive?: boolean;
  /** Previous regime — used only for change-detection logging */
  regime?: MarketRegime;
}

/**
 * Browser-safe deterministic hash (djb2 variant).
 * Works in Chrome service workers, Node.js, and test environments.
 * Not cryptographic — used only for equality checking and replay verification.
 */
function deterministicHashOf(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h) ^ input.charCodeAt(i);
    h = h >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Assemble a full immutable MarketContext from a complete set of fields.
 * Called internally by the engine after regime and confidence are resolved.
 */
export function createMarketContext(
  base: Omit<MarketContext, 'deterministicHash' | 'sequenceNumber'> & { sequenceNumber?: number }
): MarketContext {
  const sequenceNumber = base.sequenceNumber ?? 0;

  const hashInput = JSON.stringify({
    timestamp: base.timestamp,
    sequenceNumber,
    symbol: base.symbol,
    regime: base.regime,
    marketState: base.marketState,
    volatility: base.volatility,
    liquidityState: base.liquidityState,
    trendState: base.trendState,
    sessionState: base.sessionState,
    displacementQuality: base.displacementQuality,
    spread: base.spread,
    orderbookDepth: base.orderbookDepth,
    confidence: base.confidence,
    currentPrice: base.currentPrice,
    positionActive: base.positionActive
  });

  return {
    ...base,
    sequenceNumber,
    deterministicHash: deterministicHashOf(hashInput)
  };
}

export interface ConstraintResult {
  passed: boolean;
  confidenceImpact: number;
  reason: string;
  metadata?: any;
}

export interface Constraint {
  id: string;
  evaluate(ctx: MarketContext): ConstraintResult;
}

/**
 * Immutable system event with deterministic ordering.
 */
export interface SystemEvent {
  readonly exchangeTimestamp: number;
  readonly receiveTimestamp: number;
  readonly sequenceNumber: number;
  readonly eventId: string;
  readonly correlationId: string;
  readonly type: string;
  readonly payload: any;
  readonly marketContextSnapshot?: MarketContext;
  readonly decisionMetadata?: Record<string, any>;
  readonly eventVersion: number;
  readonly deterministicHash: string;
  readonly previousEventHash?: string;
}

/**
 * Create a deterministic SystemEvent.
 * Browser-safe — no Node.js APIs used.
 */
export function createSystemEvent(
  base: Omit<SystemEvent, 'deterministicHash' | 'sequenceNumber'> & {
    sequenceNumber?: number;
    previousEventHash?: string;
  }
): SystemEvent {
  const sequenceNumber = base.sequenceNumber ?? 0;

  const hashInput = JSON.stringify({
    exchangeTimestamp: base.exchangeTimestamp,
    receiveTimestamp: base.receiveTimestamp,
    sequenceNumber,
    eventId: base.eventId,
    correlationId: base.correlationId,
    type: base.type,
    payload: base.payload,
    decisionMetadata: base.decisionMetadata,
    eventVersion: base.eventVersion,
    previousEventHash: base.previousEventHash
  });

  return {
    ...base,
    sequenceNumber,
    deterministicHash: deterministicHashOf(hashInput),
    previousEventHash: base.previousEventHash
  };
}
