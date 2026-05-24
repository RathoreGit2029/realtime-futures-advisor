import { MarketContext, SystemEvent } from './Types';
import { EventLog } from './EventSourcing';
import { MarketStateMachine } from './StateMachine';
import { MarketRegimeEngine } from './MarketRegimeEngine';
import { ConstraintEngine } from './ConstraintEngine';
import { ProbabilityCalibrationEngine } from './ProbabilityCalibration';
import { CircuitBreakerEngine } from '../risk/CircuitBreakers';
import { ExecutionSafetyLayer } from '../execution/SafetyLayer';
import { ExplainabilityAPI } from './ExplainabilityAPI';

// Import Constraints
import { RegimeConstraint } from '../constraints/RegimeConstraint';
import { VolatilityConstraint } from '../constraints/VolatilityConstraint';
import { LiquidityConstraint } from '../constraints/LiquidityConstraint';
import { HTFAlignmentConstraint } from '../constraints/HTFAlignmentConstraint';

export class AntigravityEngine {
  public logger = EventLog.getInstance();
  public stateMachine = new MarketStateMachine();
  public regimeEngine = new MarketRegimeEngine();
  public constraintEngine = new ConstraintEngine();
  public probEngine = new ProbabilityCalibrationEngine();
  public circuitBreakers = new CircuitBreakerEngine();
  public safetyLayer = new ExecutionSafetyLayer();
  public api = new ExplainabilityAPI();

  constructor() {
    // Wire up the DAG
    this.constraintEngine.registerConstraint(new RegimeConstraint());
    this.constraintEngine.registerConstraint(new VolatilityConstraint());
    this.constraintEngine.registerConstraint(new LiquidityConstraint());
    this.constraintEngine.registerConstraint(new HTFAlignmentConstraint());
  }

  /**
   * Main evaluation loop. Can be run in shadow mode without triggering real trades.
   */
  public evaluateTick(context: MarketContext, isShadowMode: boolean = true): void {
    // 1. Log tick
    this.logger.append({
      type: 'TickReceived',
      correlationId: context.symbol,
      payload: { price: context.currentPrice, spread: context.spread }
    });

    // 2. Classify Regime
    context.regime = this.regimeEngine.classify(context);

    // 3. Circuit Breaker validation
    const health = this.circuitBreakers.evaluateSystemHealth(context, this.logger.getEvents({ startTs: Date.now() - 60000 }));
    if (health.halted) return; // Halt execution

    // 4. Evaluate Constraint DAG
    const decision = this.constraintEngine.evaluate(context);

    if (decision.tradeEligible && !isShadowMode) {
      // 5. Execution Safety Validation
      const intendedDirection = context.trendState.direction === 'UP' ? 'LONG' : 'SHORT';
      const safety = this.safetyLayer.validateExecution(context, intendedDirection, context.currentPrice);
      
      if (safety.safe) {
        // Trigger live trade logic (via Postgres / Background script)
        console.log(`[EXECUTE] ${intendedDirection} @ ${safety.adjustedEntry}`);
      }
    }
  }
}
