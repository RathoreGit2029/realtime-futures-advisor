export * from './Types';
export * from '../execution/SafetyLayer';
import { MarketContext, RawMarketInput, SystemEvent, createMarketContext } from './Types';
import { EventLog } from './EventSourcing';
import { MarketRegimeEngine } from './MarketRegimeEngine';
import { ConstraintEngine, ConstraintDecision } from './ConstraintEngine';
import { ProbabilityCalibrationEngine } from './ProbabilityCalibration';
import { CircuitBreakerEngine } from '../risk/CircuitBreakers';
import { ExplainabilityAPI } from './ExplainabilityAPI';
import { ExecutionSafetyLayer } from '../execution/SafetyLayer';

import { RegimeConstraint } from '../constraints/RegimeConstraint';
import { VolatilityConstraint } from '../constraints/VolatilityConstraint';
import { LiquidityConstraint } from '../constraints/LiquidityConstraint';
import { HTFAlignmentConstraint } from '../constraints/HTFAlignmentConstraint';

export interface MarketEvaluation {
  context: MarketContext;
  decision: ConstraintDecision;
  halted: boolean;
  haltReason?: string;
}

export class AntigravityEngine {
  private logger = EventLog.getInstance();
  public regimeEngine = new MarketRegimeEngine();
  public constraintEngine = new ConstraintEngine();
  public probEngine = new ProbabilityCalibrationEngine();
  public circuitBreakers = new CircuitBreakerEngine();
  public safetyLayer = new ExecutionSafetyLayer();
  public api = new ExplainabilityAPI();

  constructor() {
    // Registration order is evaluation order — intentional.
    // Cheapest / most-likely-to-fail gates first to short-circuit early.
    // 1. Regime — single enum lookup, very cheap
    // 2. Volatility — two numeric comparisons
    // 3. Liquidity — sweep quality check
    // 4. HTF Alignment — last because it depends on async REST data that may be null
    this.constraintEngine.registerConstraint(new RegimeConstraint());
    this.constraintEngine.registerConstraint(new VolatilityConstraint());
    this.constraintEngine.registerConstraint(new LiquidityConstraint());
    this.constraintEngine.registerConstraint(new HTFAlignmentConstraint());
  }

  /**
   * Single evaluation path.
   *
   * Accepts a plain context object from background.js (which cannot call
   * createMarketContext itself because it runs in a different bundle scope).
   * We normalise it here into a proper immutable context.
   *
   * Confidence flow:
   *   1. Regime is classified from the incoming context fields.
   *   2. Bayesian point estimate for that regime is fetched.
   *   3. Context is rebuilt with the real confidence value.
   *   4. Constraints gate on the rebuilt context.
   *   5. finalConfidence in the decision IS the Bayesian estimate — never synthesised.
   */
  public evaluateMarket(rawContext: RawMarketInput): MarketEvaluation {
    // Step 1 — classify regime from raw inputs
    const regime = this.regimeEngine.classifyRaw(rawContext);

    // Step 2 — Bayesian confidence for this regime
    const probabilityEstimate = this.probEngine.getCalibratedBaseConfidence(regime);

    // Step 3 — build single immutable context with correct regime + confidence
    const context = createMarketContext({
      ...rawContext,
      regime,
      confidence: probabilityEstimate.pointEstimate
    });

    // Step 4 — circuit breakers (use context.timestamp, not Date.now(), for latency check)
    const recentEvents = this.logger.getEvents({
      startTs: context.timestamp - 60_000,
      endTs: context.timestamp
    });

    const health = this.circuitBreakers.evaluateSystemHealth(context, recentEvents);

    if (health.halted) {
      this.logger.append({
        type: 'CircuitBreakerHalt',
        correlationId: context.symbol,
        payload: { reason: health.reason, breakerType: health.breakerType },
        marketContextSnapshot: context
      });
      return {
        context,
        decision: {
          tradeEligible: false,
          failedConstraints: ['CircuitBreaker'],
          passedConstraints: [],
          failureReasons: [health.reason ?? 'System halted'],
          finalConfidence: 0,
          individualEvaluations: [],
          totalEvaluationTime: 0,
          deterministicHash: ''
        },
        halted: true,
        haltReason: health.reason
      };
    }

    // Step 5 — constraint evaluation
    const decision = this.constraintEngine.evaluate(context);

    return { context, decision, halted: false };
  }

  /**
   * Replay evaluations from the in-memory event log.
   * Only useful within the same service worker lifetime.
   */
  public replayEvaluation(
    _initialContext: MarketContext,
    eventSequence: number,
    callback: (evaluation: MarketEvaluation, event: SystemEvent) => void
  ): void {
    const events = this.logger.getEvents({ startSequence: eventSequence });
    for (const event of events) {
      if (event.marketContextSnapshot) {
        // MarketContext is a superset of RawMarketInput — safe to pass directly
        const evaluation = this.evaluateMarket(event.marketContextSnapshot as RawMarketInput);
        callback(evaluation, event);
      }
    }
  }
}
