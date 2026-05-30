import { MarketContext, SystemEvent } from '../engine/Types.js';
import { EventLog } from '../engine/EventSourcing.js';

export interface CircuitBreakerState {
  halted: boolean;
  reason?: string;
  breakerType?: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

export interface CircuitBreakerConfig {
  /**
   * Maximum ratio of spread to ATR before halting.
   * Only meaningful when spread is a REAL bid-ask spread, not a synthetic estimate.
   * Set to Infinity to disable when spread is synthetic.
   */
  maxSpreadToAtrRatio: number;

  /** Maximum age of the context timestamp vs wall clock before halting (ms). */
  maxDataLatencyMs: number;

  /** Maximum consecutive ExecutionRejected events in the rolling window. */
  maxConsecutiveRejections: number;

  /** Volatility rank above which execution is halted. */
  maxVolatilityRank: number;

  /**
   * Minimum sweep quality to allow execution.
   * Only enforced when marketState is EXECUTION_WINDOW (i.e. a sweep was detected).
   * When there is no sweep, sweepQuality is 0 — we must NOT halt on that.
   */
  minSweepQualityWhenSweepPresent: number;
}

export class CircuitBreakerEngine {
  private logger = EventLog.getInstance();
  private config: CircuitBreakerConfig;

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = {
      // Disabled by default because background.js uses a synthetic spread.
      // Enable and lower this threshold only when real order-book spread is available.
      maxSpreadToAtrRatio: Infinity,
      maxDataLatencyMs: 5000,
      maxConsecutiveRejections: 5,
      maxVolatilityRank: 95,
      minSweepQualityWhenSweepPresent: 40,
      ...config
    };
  }

  /**
   * Evaluate system health in deterministic order.
   * Uses context.timestamp (Binance server time) for latency, not Date.now(),
   * so the check is consistent with the context's own time reference.
   *
   * wallClockNow is injected so callers can pass Date.now() explicitly,
   * making the check testable and deterministic in replay.
   */
  public evaluateSystemHealth(
    context: MarketContext,
    recentEvents: SystemEvent[],
    wallClockNow: number = Date.now()
  ): CircuitBreakerState {

    // Check 1: Extreme volatility — highest priority
    if (context.volatility.historicalRank > this.config.maxVolatilityRank) {
      return this.halt(
        `Volatility rank ${context.volatility.historicalRank} > ${this.config.maxVolatilityRank}`,
        'EXTREME_VOLATILITY',
        'HIGH'
      );
    }

    // Check 2: Spread vs ATR — only meaningful with real spread data
    if (
      this.config.maxSpreadToAtrRatio !== Infinity &&
      context.volatility.atr > 0 &&
      context.spread > context.volatility.atr * this.config.maxSpreadToAtrRatio
    ) {
      return this.halt(
        `Spread ${context.spread.toFixed(4)} > ${this.config.maxSpreadToAtrRatio * 100}% of ATR ${context.volatility.atr.toFixed(4)}`,
        'SPREAD_EXPLOSION',
        'HIGH'
      );
    }

    // Check 3: Data latency — compare Binance event time against wall clock
    const latencyMs = wallClockNow - context.timestamp;
    if (latencyMs > this.config.maxDataLatencyMs) {
      return this.halt(
        `Data latency ${latencyMs}ms > ${this.config.maxDataLatencyMs}ms`,
        'DATA_LATENCY',
        'MEDIUM'
      );
    }

    // Check 4: Execution rejection cascade
    const recentRejections = recentEvents.filter(e => e.type === 'ExecutionRejected');
    if (recentRejections.length > this.config.maxConsecutiveRejections) {
      return this.halt(
        `${recentRejections.length} consecutive execution rejections`,
        'REJECTION_CASCADE',
        'CRITICAL'
      );
    }

    // Check 5: Sweep quality — only when a sweep is actually present
    // sweepQuality = 0 means no sweep detected, which is normal — do NOT halt on that
    if (
      context.liquidityState.hasSweep &&
      context.liquidityState.sweepQuality < this.config.minSweepQualityWhenSweepPresent
    ) {
      return this.halt(
        `Sweep quality ${context.liquidityState.sweepQuality} < ${this.config.minSweepQualityWhenSweepPresent} (sweep present but weak)`,
        'WEAK_SWEEP',
        'LOW'
      );
    }

    return { halted: false, severity: 'LOW' };
  }

  private halt(reason: string, breakerType: string, severity: CircuitBreakerState['severity']): CircuitBreakerState {
    this.logger.append({
      type: 'CircuitBreakerTriggered',
      correlationId: 'system',
      payload: { reason, breakerType, severity }
    });
    return { halted: true, reason, breakerType, severity };
  }

  public getConfig(): CircuitBreakerConfig {
    return { ...this.config };
  }
}
