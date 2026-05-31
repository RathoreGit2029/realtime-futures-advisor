"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AntigravityEngine = void 0;
__exportStar(require("./Types.js"), exports);
__exportStar(require("../execution/SafetyLayer.js"), exports);
__exportStar(require("./EventSourcing.js"), exports);
const Types_js_1 = require("./Types.js");
const EventSourcing_js_1 = require("./EventSourcing.js");
const MarketRegimeEngine_js_1 = require("./MarketRegimeEngine.js");
const ConstraintEngine_js_1 = require("./ConstraintEngine.js");
const ProbabilityCalibration_js_1 = require("./ProbabilityCalibration.js");
const CircuitBreakers_js_1 = require("../risk/CircuitBreakers.js");
const ExplainabilityAPI_js_1 = require("./ExplainabilityAPI.js");
const SafetyLayer_js_1 = require("../execution/SafetyLayer.js");
const StateMachine_js_1 = require("./StateMachine.js");
const RegimeConstraint_js_1 = require("../constraints/RegimeConstraint.js");
const VolatilityConstraint_js_1 = require("../constraints/VolatilityConstraint.js");
const LiquidityConstraint_js_1 = require("../constraints/LiquidityConstraint.js");
const HTFAlignmentConstraint_js_1 = require("../constraints/HTFAlignmentConstraint.js");
const MicrostructureConstraint_js_1 = require("../constraints/MicrostructureConstraint.js");
const PortfolioHeatConstraint_js_1 = require("../constraints/PortfolioHeatConstraint.js");
class AntigravityEngine {
    logger = EventSourcing_js_1.EventLog.getInstance();
    regimeEngine = new MarketRegimeEngine_js_1.MarketRegimeEngine();
    constraintEngine = new ConstraintEngine_js_1.ConstraintEngine();
    probEngine = new ProbabilityCalibration_js_1.ProbabilityCalibrationEngine();
    circuitBreakers = new CircuitBreakers_js_1.CircuitBreakerEngine();
    safetyLayer = new SafetyLayer_js_1.ExecutionSafetyLayer();
    api = new ExplainabilityAPI_js_1.ExplainabilityAPI();
    stateMachine = new StateMachine_js_1.StateMachine();
    constructor() {
        // Registration order is evaluation order — intentional.
        // Cheapest / most-likely-to-fail gates first to short-circuit early.
        // 1. Regime — single enum lookup, very cheap
        // 2. Volatility — two numeric comparisons
        // 3. Liquidity — sweep quality check
        // 4. HTF Alignment — last because it depends on async REST data that may be null
        // 5. Microstructure — orderbook L2 checks before final execution gate
        // 6. Portfolio Heat — portfolio correlation and margin checks
        this.constraintEngine.registerConstraint(new RegimeConstraint_js_1.RegimeConstraint());
        this.constraintEngine.registerConstraint(new VolatilityConstraint_js_1.VolatilityConstraint());
        this.constraintEngine.registerConstraint(new LiquidityConstraint_js_1.LiquidityConstraint());
        this.constraintEngine.registerConstraint(new HTFAlignmentConstraint_js_1.HTFAlignmentConstraint());
        this.constraintEngine.registerConstraint(new MicrostructureConstraint_js_1.MicrostructureConstraint());
        this.constraintEngine.registerConstraint(new PortfolioHeatConstraint_js_1.PortfolioHeatConstraint());
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
    evaluateMarket(rawContext) {
        // Step 1 — classify regime from raw inputs
        const regime = this.regimeEngine.classifyRaw(rawContext);
        // Step 2 — Bayesian confidence for this regime
        const probabilityEstimate = this.probEngine.getCalibratedBaseConfidence(regime);
        // Step 3 — build single immutable context with correct regime + confidence
        let context = (0, Types_js_1.createMarketContext)({
            ...rawContext,
            regime,
            confidence: probabilityEstimate.pointEstimate
        });
        // Step 3.5 — Run State Machine transitions & override state
        const hasActivePosition = !!rawContext.positionActive;
        const nextState = this.stateMachine.determineNextState(context, hasActivePosition);
        this.stateMachine.transitionTo(context.symbol, nextState, `Market evaluation tick for ${context.symbol}`);
        const validatedState = this.stateMachine.getCurrentState(context.symbol);
        context = (0, Types_js_1.createMarketContext)({
            ...rawContext,
            regime,
            confidence: probabilityEstimate.pointEstimate,
            marketState: validatedState
        });
        // Step 4 — circuit breakers (use context.timestamp, not Date.now(), for latency check)
        const recentEvents = this.logger.getEvents({
            startTs: context.timestamp - 60_000,
            endTs: context.timestamp
        });
        const health = this.circuitBreakers.evaluateSystemHealth(context, recentEvents, this.logger.getClock().now());
        if (health.halted) {
            const decision = {
                tradeEligible: false,
                failedConstraints: ['CircuitBreaker'],
                passedConstraints: [],
                failureReasons: [health.reason ?? 'System halted'],
                finalConfidence: 0,
                individualEvaluations: [],
                totalEvaluationTime: 0,
                deterministicHash: ''
            };
            this.logger.append({
                type: 'MarketEvaluationRecorded',
                correlationId: context.symbol,
                payload: {
                    decision,
                    halted: true,
                    haltReason: health.reason
                },
                marketContextSnapshot: context
            });
            return {
                context,
                decision,
                halted: true,
                haltReason: health.reason
            };
        }
        // Step 5 — constraint evaluation
        const decision = this.constraintEngine.evaluate(context);
        this.logger.append({
            type: 'MarketEvaluationRecorded',
            correlationId: context.symbol,
            payload: {
                decision: {
                    tradeEligible: decision.tradeEligible,
                    finalConfidence: decision.finalConfidence,
                    failedConstraints: decision.failedConstraints,
                    passedConstraints: decision.passedConstraints,
                    failureReasons: decision.failureReasons,
                    deterministicHash: decision.deterministicHash
                },
                halted: false
            },
            marketContextSnapshot: context
        });
        return { context, decision, halted: false };
    }
    /**
     * Replay evaluations from the in-memory event log.
     * Only useful within the same service worker lifetime.
     */
    replayEvaluation(_initialContext, eventSequence, callback) {
        const events = this.logger.getEvents({ startSequence: eventSequence });
        for (const event of events) {
            if (event.marketContextSnapshot) {
                // MarketContext is a superset of RawMarketInput — safe to pass directly
                const evaluation = this.evaluateMarket(event.marketContextSnapshot);
                callback(evaluation, event);
            }
        }
    }
}
exports.AntigravityEngine = AntigravityEngine;
