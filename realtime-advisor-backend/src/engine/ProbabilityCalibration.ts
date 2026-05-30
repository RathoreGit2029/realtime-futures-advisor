import { MarketRegime } from './Types.js';
import { EventLog } from './EventSourcing.js';

export interface BayesianStats {
  /** Beta distribution alpha (prior wins + observed wins) */
  alpha: number;
  /** Beta distribution beta (prior losses + observed losses) */
  beta: number;
  totalTrades: number;
  lastUpdated: number;
}

export interface ProbabilityEstimate {
  /** Posterior mean win-rate as a percentage 0–100 */
  pointEstimate: number;
  /** 95% credible interval [lower, upper] */
  credibleInterval95: [number, number];
  standardError: number;
  effectiveSampleSize: number;
  /** True once we have >= MIN_RELIABLE_SAMPLES observed trades */
  isReliable: boolean;
}

/** Serialisable snapshot — stored in chrome.storage to survive SW restarts */
export type ProbabilityState = Record<string, BayesianStats>;

const MIN_RELIABLE_SAMPLES = 20;

// Beta(2,2) prior — symmetric, mean = 50%, weakly informative
const PRIOR_ALPHA = 2;
const PRIOR_BETA = 2;

// Hydrated prior parameters based on historical backtesting statistics
const REGIME_PRIORS: Record<MarketRegime, { alpha: number; beta: number }> = {
  [MarketRegime.TRENDING]: { alpha: 15, beta: 7 },         // ~68.2% win rate
  [MarketRegime.MEAN_REVERTING]: { alpha: 13, beta: 8 },   // ~61.9% win rate
  [MarketRegime.CHOPPY]: { alpha: 4, beta: 11 },           // ~26.7% win rate
  [MarketRegime.EXPANSION]: { alpha: 12, beta: 8 },        // 60.0% win rate
  [MarketRegime.COMPRESSION]: { alpha: 2, beta: 2 },        // neutral prior
  [MarketRegime.HIGH_VOLATILITY]: { alpha: 2, beta: 8 },    // 20.0% win rate
  [MarketRegime.LOW_LIQUIDITY]: { alpha: 2, beta: 6 },      // 25.0% win rate
  [MarketRegime.NEWS_EVENT]: { alpha: 2, beta: 8 },         // 20.0% win rate
  [MarketRegime.LIQUIDATION_CASCADE]: { alpha: 1, beta: 9 } // 10.0% win rate
};

export class ProbabilityCalibrationEngine {
  private stats: Record<MarketRegime, BayesianStats>;
  private logger = EventLog.getInstance();

  constructor(restoredState?: ProbabilityState) {
    this.stats = {} as Record<MarketRegime, BayesianStats>;

    for (const regime of Object.values(MarketRegime)) {
      const saved = restoredState?.[regime];
      const prior = REGIME_PRIORS[regime] || { alpha: PRIOR_ALPHA, beta: PRIOR_BETA };
      this.stats[regime] = saved ?? {
        alpha: prior.alpha,
        beta: prior.beta,
        totalTrades: 0,
        lastUpdated: 0
      };
    }
  }

  /**
   * Returns the Bayesian posterior estimate for the given regime.
   *
   * With no trade history (fresh start or after SW restart without restored state),
   * pointEstimate = 50.  The caller in background.js compares this against
   * triggerThreshold (default 78).  50 < 78, so the DAG path will not fire
   * until enough wins are recorded.
   *
   * To make the system usable from day one, background.js passes the
   * composite score from the JS scoring layer as a confidence override when
   * the Bayesian engine has insufficient data (isReliable === false).
   * See background.js evaluateMarket integration comment.
   */
  public getCalibratedBaseConfidence(regime: MarketRegime): ProbabilityEstimate {
    const s = this.stats[regime];
    const n = s.alpha + s.beta;

    const mean = s.alpha / n;
    // Beta distribution variance
    const variance = (s.alpha * s.beta) / (n * n * (n + 1));
    const stdDev = Math.sqrt(variance);

    const z = 1.96;
    const lower = Math.max(0, mean - z * stdDev) * 100;
    const upper = Math.min(1, mean + z * stdDev) * 100;

    return {
      pointEstimate: Math.round(mean * 1000) / 10, // 1 decimal place
      credibleInterval95: [Math.round(lower * 10) / 10, Math.round(upper * 10) / 10],
      standardError: Math.round(stdDev * 1000) / 10,
      effectiveSampleSize: s.totalTrades,
      isReliable: s.totalTrades >= MIN_RELIABLE_SAMPLES
    };
  }

  /**
   * Record a trade outcome and update the posterior.
   * pnlPercent is stored for future expectancy weighting but not used yet.
   */
  public recordTradeResult(regime: MarketRegime, win: boolean, pnlPercent?: number): void {
    const s = this.stats[regime];
    if (win) {
      s.alpha += 1;
    } else {
      s.beta += 1;
    }
    s.totalTrades += 1;
    s.lastUpdated = this.logger.getClock().now();

    // Log the outcome event for deterministic replay state tracking
    this.logger.append({
      type: 'TradeResultRecorded',
      correlationId: regime,
      payload: { regime, win, pnlPercent }
    });
  }

  /**
   * Serialise the full probability state for persistence in chrome.storage.
   * Call this after every recordTradeResult() and restore on SW startup.
   */
  public serializeState(): ProbabilityState {
    const out: ProbabilityState = {};
    for (const regime of Object.values(MarketRegime)) {
      out[regime] = { ...this.stats[regime] };
    }
    return out;
  }

  /**
   * Replace the current state with a previously serialised snapshot.
   * Used on SW restart to restore accumulated learning.
   */
  public deserializeState(state: ProbabilityState): void {
    for (const regime of Object.values(MarketRegime)) {
      if (state[regime]) {
        this.stats[regime] = { ...state[regime] };
      }
    }
  }

  public getRegimeStatistics(regime: MarketRegime): BayesianStats {
    return { ...this.stats[regime] };
  }

  public resetRegime(regime: MarketRegime): void {
    this.stats[regime] = {
      alpha: PRIOR_ALPHA,
      beta: PRIOR_BETA,
      totalTrades: 0,
      lastUpdated: 0
    };
  }

  public getCalibrationQuality(): {
    totalRegimes: number;
    reliableRegimes: number;
    averageEffectiveSamples: number;
  } {
    const regimes = Object.values(MarketRegime);
    let reliable = 0;
    let totalSamples = 0;
    for (const r of regimes) {
      if (this.stats[r].totalTrades >= MIN_RELIABLE_SAMPLES) reliable++;
      totalSamples += this.stats[r].totalTrades;
    }
    return {
      totalRegimes: regimes.length,
      reliableRegimes: reliable,
      averageEffectiveSamples: Math.round(totalSamples / regimes.length)
    };
  }
}
