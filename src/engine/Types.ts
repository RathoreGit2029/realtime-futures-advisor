export enum MarketState {
  ACCUMULATION = 'ACCUMULATION',
  LIQUIDITY_SWEEP = 'LIQUIDITY_SWEEP',
  DISPLACEMENT = 'DISPLACEMENT',
  RETRACEMENT = 'RETRACEMENT',
  EXECUTION_WINDOW = 'EXECUTION_WINDOW',
  EXPANSION = 'EXPANSION',
  REVERSAL = 'REVERSAL',
  CHOPPY = 'CHOPPY',
  NO_TRADE = 'NO_TRADE'
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

export interface MarketContext {
  timestamp: number;
  symbol: string;
  regime: MarketRegime;
  marketState: MarketState;
  volatility: VolatilityState;
  liquidityState: LiquidityState;
  trendState: TrendState;
  sessionState: SessionState;
  displacementQuality: number; // 0-100
  spread: number;
  orderbookDepth?: number;
  confidence: number; // probability calibration, not synthetic score
  currentPrice: number;
}

export interface ConstraintResult {
  passed: boolean;
  confidenceImpact: number; // Contextual probability adjustment
  reason: string;
  metadata?: any;
}

export interface Constraint {
  id: string;
  evaluate(ctx: MarketContext): ConstraintResult;
}

export interface SystemEvent {
  timestamp: number;
  eventId: string;
  correlationId: string;
  type: string;
  payload: any;
  marketSnapshot?: MarketContext;
}
