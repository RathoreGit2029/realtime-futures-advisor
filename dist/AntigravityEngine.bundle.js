"use strict";
var AntigravityCore = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/engine/AntigravityEngine.ts
  var AntigravityEngine_exports = {};
  __export(AntigravityEngine_exports, {
    AntigravityEngine: () => AntigravityEngine,
    MarketRegime: () => MarketRegime,
    MarketState: () => MarketState
  });

  // src/engine/Types.ts
  var MarketState = /* @__PURE__ */ ((MarketState2) => {
    MarketState2["ACCUMULATION"] = "ACCUMULATION";
    MarketState2["LIQUIDITY_SWEEP"] = "LIQUIDITY_SWEEP";
    MarketState2["DISPLACEMENT"] = "DISPLACEMENT";
    MarketState2["RETRACEMENT"] = "RETRACEMENT";
    MarketState2["EXECUTION_WINDOW"] = "EXECUTION_WINDOW";
    MarketState2["EXPANSION"] = "EXPANSION";
    MarketState2["REVERSAL"] = "REVERSAL";
    MarketState2["CHOPPY"] = "CHOPPY";
    MarketState2["NO_TRADE"] = "NO_TRADE";
    return MarketState2;
  })(MarketState || {});
  var MarketRegime = /* @__PURE__ */ ((MarketRegime2) => {
    MarketRegime2["TRENDING"] = "TRENDING";
    MarketRegime2["MEAN_REVERTING"] = "MEAN_REVERTING";
    MarketRegime2["CHOPPY"] = "CHOPPY";
    MarketRegime2["EXPANSION"] = "EXPANSION";
    MarketRegime2["COMPRESSION"] = "COMPRESSION";
    MarketRegime2["HIGH_VOLATILITY"] = "HIGH_VOLATILITY";
    MarketRegime2["LOW_LIQUIDITY"] = "LOW_LIQUIDITY";
    MarketRegime2["NEWS_EVENT"] = "NEWS_EVENT";
    MarketRegime2["LIQUIDATION_CASCADE"] = "LIQUIDATION_CASCADE";
    return MarketRegime2;
  })(MarketRegime || {});

  // src/engine/EventSourcing.ts
  var EventLog = class _EventLog {
    events = [];
    pendingQueue = [];
    isProcessingQueue = false;
    static instance;
    constructor() {
    }
    static getInstance() {
      if (!_EventLog.instance) {
        _EventLog.instance = new _EventLog();
      }
      return _EventLog.instance;
    }
    /**
     * Appends an event to the immutable log.
     */
    append(event) {
      const fullEvent = {
        ...event,
        timestamp: Date.now(),
        eventId: crypto.randomUUID()
      };
      this.events.push(fullEvent);
      if (this.events.length > 1e3) {
        this.events.shift();
      }
      this.pendingQueue.push(fullEvent);
      this.triggerQueueProcessor();
      return fullEvent;
    }
    triggerQueueProcessor() {
      if (this.isProcessingQueue) return;
      this.isProcessingQueue = true;
      this.processQueue();
    }
    async processQueue() {
      if (this.pendingQueue.length === 0) {
        this.isProcessingQueue = false;
        return;
      }
      const event = this.pendingQueue[0];
      try {
        const response = await fetch("http://localhost:4000/api/advisor/events", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(event)
        });
        if (response.ok) {
          this.pendingQueue.shift();
        } else {
          console.warn(`PostgreSQL Ledger error ${response.status}, retrying in 5s...`);
          setTimeout(() => this.processQueue(), 5e3);
          return;
        }
      } catch (err) {
        console.warn("PostgreSQL Ledger offline, retrying in 5s:", err.message);
        setTimeout(() => this.processQueue(), 5e3);
        return;
      }
      setTimeout(() => this.processQueue(), 100);
    }
    /**
     * Replays events for a given correlation ID or time range
     */
    getEvents(filter) {
      let result = this.events;
      if (filter) {
        if (filter.startTs) result = result.filter((e) => e.timestamp >= filter.startTs);
        if (filter.endTs) result = result.filter((e) => e.timestamp <= filter.endTs);
        if (filter.correlationId) result = result.filter((e) => e.correlationId === filter.correlationId);
      }
      return result;
    }
    clear() {
      this.events = [];
      this.pendingQueue = [];
      this.isProcessingQueue = false;
    }
  };

  // src/engine/StateMachine.ts
  var MarketStateMachine = class {
    currentState = "NO_TRADE" /* NO_TRADE */;
    logger = EventLog.getInstance();
    getCurrentState() {
      return this.currentState;
    }
    /**
     * Deterministic state transition
     */
    transition(newState, context, reason) {
      const isValid = this.validateTransition(this.currentState, newState);
      if (isValid) {
        this.logger.append({
          type: "StateTransition",
          correlationId: context.symbol,
          payload: {
            from: this.currentState,
            to: newState,
            reason
          },
          marketSnapshot: context
        });
        this.currentState = newState;
        return true;
      }
      this.logger.append({
        type: "InvalidStateTransitionAttempt",
        correlationId: context.symbol,
        payload: {
          from: this.currentState,
          attemptedTo: newState,
          reason: "Violated DAG topology"
        },
        marketSnapshot: context
      });
      return false;
    }
    validateTransition(from, to) {
      const validTransitions = {
        ["NO_TRADE" /* NO_TRADE */]: ["ACCUMULATION" /* ACCUMULATION */, "CHOPPY" /* CHOPPY */],
        ["CHOPPY" /* CHOPPY */]: ["ACCUMULATION" /* ACCUMULATION */, "NO_TRADE" /* NO_TRADE */],
        ["ACCUMULATION" /* ACCUMULATION */]: ["LIQUIDITY_SWEEP" /* LIQUIDITY_SWEEP */, "CHOPPY" /* CHOPPY */],
        ["LIQUIDITY_SWEEP" /* LIQUIDITY_SWEEP */]: ["DISPLACEMENT" /* DISPLACEMENT */, "REVERSAL" /* REVERSAL */],
        ["DISPLACEMENT" /* DISPLACEMENT */]: ["RETRACEMENT" /* RETRACEMENT */, "EXPANSION" /* EXPANSION */],
        ["RETRACEMENT" /* RETRACEMENT */]: ["EXECUTION_WINDOW" /* EXECUTION_WINDOW */, "REVERSAL" /* REVERSAL */],
        ["EXECUTION_WINDOW" /* EXECUTION_WINDOW */]: ["EXPANSION" /* EXPANSION */, "REVERSAL" /* REVERSAL */, "NO_TRADE" /* NO_TRADE */],
        ["EXPANSION" /* EXPANSION */]: ["ACCUMULATION" /* ACCUMULATION */, "REVERSAL" /* REVERSAL */],
        ["REVERSAL" /* REVERSAL */]: ["ACCUMULATION" /* ACCUMULATION */, "CHOPPY" /* CHOPPY */]
      };
      return validTransitions[from]?.includes(to) ?? false;
    }
  };

  // src/engine/MarketRegimeEngine.ts
  var MarketRegimeEngine = class {
    logger = EventLog.getInstance();
    /**
     * Evaluates the current regime based on context data.
     * In Phase 1, this uses basic heuristic boundaries.
     * Future phases will use the probability engine.
     */
    classify(context) {
      const { volatility, trendState, sessionState } = context;
      let newRegime = "CHOPPY" /* CHOPPY */;
      if (sessionState.isOverlap && volatility.isExpanding && trendState.strength > 70) {
        newRegime = "TRENDING" /* TRENDING */;
      } else if (volatility.isCompressing && trendState.strength < 30) {
        newRegime = "COMPRESSION" /* COMPRESSION */;
      } else if (volatility.historicalRank > 95) {
        newRegime = "HIGH_VOLATILITY" /* HIGH_VOLATILITY */;
      } else if (trendState.direction === "SIDEWAYS" && volatility.atr > 0) {
        newRegime = "MEAN_REVERTING" /* MEAN_REVERTING */;
      }
      if (context.regime !== newRegime) {
        this.logger.append({
          type: "RegimeChanged",
          correlationId: context.symbol,
          payload: {
            from: context.regime,
            to: newRegime,
            reason: `Volatility Rank: ${volatility.historicalRank}, Trend Strength: ${trendState.strength}`
          },
          marketSnapshot: context
        });
      }
      return newRegime;
    }
  };

  // src/engine/ConstraintEngine.ts
  var ConstraintEngine = class {
    constraints = [];
    logger = EventLog.getInstance();
    /**
     * Registers a constraint into the DAG.
     * Order matters as it acts as a short-circuit DAG.
     */
    registerConstraint(constraint) {
      this.constraints.push(constraint);
    }
    /**
     * Evaluates the sequence of constraints.
     * Returns a comprehensive explanation object.
     */
    evaluate(context) {
      const failedConstraints = [];
      const passedConstraints = [];
      let currentConfidence = context.confidence;
      for (const constraint of this.constraints) {
        const result = constraint.evaluate(context);
        if (!result.passed) {
          failedConstraints.push(constraint.id);
          this.logger.append({
            type: "ConstraintRejected",
            correlationId: context.symbol,
            payload: {
              constraintId: constraint.id,
              reason: result.reason
            },
            marketSnapshot: context
          });
          return {
            tradeEligible: false,
            failedConstraints,
            passedConstraints,
            finalConfidence: 0
          };
        }
        passedConstraints.push(constraint.id);
        currentConfidence += result.confidenceImpact;
        this.logger.append({
          type: "ConstraintPassed",
          correlationId: context.symbol,
          payload: {
            constraintId: constraint.id,
            impact: result.confidenceImpact
          }
        });
      }
      return {
        tradeEligible: true,
        failedConstraints,
        passedConstraints,
        finalConfidence: currentConfidence
      };
    }
  };

  // src/engine/ProbabilityCalibration.ts
  var ProbabilityCalibrationEngine = class {
    regimeWinRates = {
      ["TRENDING" /* TRENDING */]: { wins: 0, losses: 0, winSums: 0, lossSums: 0 },
      ["MEAN_REVERTING" /* MEAN_REVERTING */]: { wins: 0, losses: 0, winSums: 0, lossSums: 0 },
      ["CHOPPY" /* CHOPPY */]: { wins: 0, losses: 0, winSums: 0, lossSums: 0 },
      ["EXPANSION" /* EXPANSION */]: { wins: 0, losses: 0, winSums: 0, lossSums: 0 },
      ["COMPRESSION" /* COMPRESSION */]: { wins: 0, losses: 0, winSums: 0, lossSums: 0 },
      ["HIGH_VOLATILITY" /* HIGH_VOLATILITY */]: { wins: 0, losses: 0, winSums: 0, lossSums: 0 },
      ["LOW_LIQUIDITY" /* LOW_LIQUIDITY */]: { wins: 0, losses: 0, winSums: 0, lossSums: 0 },
      ["NEWS_EVENT" /* NEWS_EVENT */]: { wins: 0, losses: 0, winSums: 0, lossSums: 0 },
      ["LIQUIDATION_CASCADE" /* LIQUIDATION_CASCADE */]: { wins: 0, losses: 0, winSums: 0, lossSums: 0 }
    };
    /**
     * Calculates dynamic probability score based on historical performance in similar contexts.
     * Utilizes Laplace smoothing and expectancy filters to prevent overfitting.
     */
    getCalibratedBaseConfidence(regime) {
      const stats = this.regimeWinRates[regime];
      const totalTrades = stats.wins + stats.losses;
      const alpha = 2;
      const smoothedWinRate = (stats.wins + alpha) / (totalTrades + 2 * alpha) * 100;
      if (totalTrades < 10) {
        return Math.round(smoothedWinRate);
      }
      const winRate = stats.wins / totalTrades;
      const lossRate = stats.losses / totalTrades;
      const avgWin = stats.wins > 0 ? stats.winSums / stats.wins : 0;
      const avgLoss = stats.losses > 0 ? stats.lossSums / stats.losses : 0;
      const expectancy = winRate * avgWin - lossRate * avgLoss;
      let calibratedConfidence = smoothedWinRate;
      if (expectancy < 0) {
        calibratedConfidence = Math.max(0, smoothedWinRate * 0.5);
      } else if (expectancy > 0) {
        calibratedConfidence = Math.min(100, smoothedWinRate * 1.2);
      }
      return Math.round(calibratedConfidence);
    }
    recordTradeResult(regime, win, pnlPercent) {
      const stats = this.regimeWinRates[regime];
      const pnlValue = pnlPercent !== void 0 ? Math.abs(pnlPercent) : 1;
      if (win) {
        stats.wins++;
        stats.winSums += pnlValue;
      } else {
        stats.losses++;
        stats.lossSums += pnlValue;
      }
    }
  };

  // src/risk/CircuitBreakers.ts
  var CircuitBreakerEngine = class {
    logger = EventLog.getInstance();
    /**
     * Evaluates system health and market conditions to determine if trading should halt.
     */
    evaluateSystemHealth(context, recentEvents) {
      const { volatility, spread } = context;
      if (volatility.atr > 0 && spread > volatility.atr * 0.25) {
        this.logger.append({
          type: "CircuitBreakerTriggered",
          correlationId: context.symbol,
          payload: { reason: "Spread exploded relative to ATR" }
        });
        return { halted: true, reason: "Spread exploded relative to ATR" };
      }
      const latency = Date.now() - context.timestamp;
      if (latency > 3e3) {
        this.logger.append({
          type: "CircuitBreakerTriggered",
          correlationId: context.symbol,
          payload: { reason: `Data latency spike: ${latency}ms` }
        });
        return { halted: true, reason: `Data latency spike: ${latency}ms` };
      }
      const recentExecutionRejections = recentEvents.filter((e) => e.type === "ExecutionRejected");
      if (recentExecutionRejections.length > 5) {
        return { halted: true, reason: "High frequency execution rejections (Execution Failure Cascade)" };
      }
      return { halted: false };
    }
  };

  // src/execution/SafetyLayer.ts
  var ExecutionSafetyLayer = class {
    logger = EventLog.getInstance();
    /**
     * Validates if a generated signal is safe to execute in the real market.
     * Simulates institutional conditions like slippage and delayed fills.
     */
    validateExecution(context, intendedDirection, intendedEntryPrice) {
      const { spread, currentPrice, volatility } = context;
      const deviation = Math.abs(currentPrice - intendedEntryPrice);
      if (deviation > volatility.atr * 0.05) {
        this.logger.append({
          type: "ExecutionRejected",
          correlationId: context.symbol,
          payload: { reason: `Price deviated too far from intended entry. Deviation=${deviation}` },
          marketSnapshot: context
        });
        return { safe: false, reason: "Price deviated too far (Stale Entry)" };
      }
      const estimatedSlippage = spread * 1.5;
      const adjustedEntry = intendedDirection === "LONG" ? currentPrice + estimatedSlippage : currentPrice - estimatedSlippage;
      this.logger.append({
        type: "ExecutionValidated",
        correlationId: context.symbol,
        payload: { intendedEntryPrice, adjustedEntry, estimatedSlippage },
        marketSnapshot: context
      });
      return {
        safe: true,
        adjustedEntry
      };
    }
  };

  // src/engine/ExplainabilityAPI.ts
  var ExplainabilityAPI = class {
    eventLog = EventLog.getInstance();
    /**
     * Explains why a trade was rejected or accepted based on recent events.
     */
    explainRecentDecisions(symbol, timeWindowMs = 6e4) {
      const startTime = Date.now() - timeWindowMs;
      const recentEvents = this.eventLog.getEvents({ startTs: startTime, correlationId: symbol });
      const rejections = recentEvents.filter((e) => e.type === "ConstraintRejected");
      const stateTransitions = recentEvents.filter((e) => e.type === "StateTransition");
      const executionDecisions = recentEvents.filter((e) => e.type === "ExecutionValidated" || e.type === "ExecutionRejected");
      const activeBlockers = new Set(rejections.map((e) => e.payload.reason));
      const currentStateEvent = [...stateTransitions].reverse()[0];
      const currentState = currentStateEvent ? currentStateEvent.payload.to : "NO_TRADE" /* NO_TRADE */;
      return {
        symbol,
        currentState,
        tradeEligible: rejections.length === 0 && currentState === "EXECUTION_WINDOW" /* EXECUTION_WINDOW */,
        activeBlockers: Array.from(activeBlockers),
        recentTransitions: stateTransitions.map((e) => ({
          time: new Date(e.timestamp).toISOString(),
          from: e.payload.from,
          to: e.payload.to,
          reason: e.payload.reason
        })),
        executionSafety: executionDecisions.length > 0 ? executionDecisions[executionDecisions.length - 1].payload : null
      };
    }
  };

  // src/constraints/RegimeConstraint.ts
  var RegimeConstraint = class {
    id = "RegimeConstraint";
    allowedRegimes;
    constructor(allowedRegimes = ["TRENDING" /* TRENDING */, "COMPRESSION" /* COMPRESSION */, "MEAN_REVERTING" /* MEAN_REVERTING */]) {
      this.allowedRegimes = allowedRegimes;
    }
    evaluate(ctx) {
      const isAllowed = this.allowedRegimes.includes(ctx.regime);
      if (!isAllowed) {
        return {
          passed: false,
          confidenceImpact: 0,
          reason: `Regime ${ctx.regime} is not in allowed list: [${this.allowedRegimes.join(", ")}]`
        };
      }
      let impact = 0;
      if (ctx.regime === "TRENDING" /* TRENDING */) impact = 15;
      if (ctx.regime === "MEAN_REVERTING" /* MEAN_REVERTING */) impact = 5;
      return {
        passed: true,
        confidenceImpact: impact,
        reason: `Regime ${ctx.regime} aligns with execution strategy.`
      };
    }
  };

  // src/constraints/VolatilityConstraint.ts
  var VolatilityConstraint = class {
    id = "VolatilityConstraint";
    evaluate(ctx) {
      const { volatility, spread } = ctx;
      if (volatility.historicalRank > 95) {
        return {
          passed: false,
          confidenceImpact: 0,
          reason: `Volatility rank ${volatility.historicalRank} > 95. Too dangerous to execute.`
        };
      }
      if (volatility.isExpanding && spread > volatility.atr * 0.1) {
        return {
          passed: false,
          confidenceImpact: 0,
          reason: `Spread expansion detected during volatility spike. Spread=${spread}, ATR=${volatility.atr}`
        };
      }
      return {
        passed: true,
        confidenceImpact: volatility.isCompressing ? 10 : 0,
        // Compression gives higher probability of incoming expansion
        reason: "Volatility conditions are within safe execution parameters."
      };
    }
  };

  // src/constraints/LiquidityConstraint.ts
  var LiquidityConstraint = class {
    id = "LiquidityConstraint";
    evaluate(ctx) {
      const { liquidityState, marketState, trendState } = ctx;
      if (marketState === "EXECUTION_WINDOW" /* EXECUTION_WINDOW */) {
        if (!liquidityState.hasSweep) {
          return {
            passed: false,
            confidenceImpact: 0,
            reason: "No liquidity sweep detected prior to execution window. Institutional trap risk high."
          };
        }
        if (liquidityState.sweepQuality < 40) {
          return {
            passed: false,
            confidenceImpact: 0,
            reason: `Sweep quality too low (${liquidityState.sweepQuality}). Potential weak hands trap.`
          };
        }
        const intendedTradeDirection = trendState.direction;
        if (intendedTradeDirection === "UP" && liquidityState.recentSweepDirection === "BULLISH") {
          return {
            passed: false,
            confidenceImpact: 0,
            reason: "Sweep direction opposes logical entry. Swept highs, but looking for longs."
          };
        }
      }
      return {
        passed: true,
        confidenceImpact: liquidityState.sweepQuality > 80 ? 15 : 5,
        reason: "Liquidity sweep confirmed and valid."
      };
    }
  };

  // src/constraints/HTFAlignmentConstraint.ts
  var HTFAlignmentConstraint = class {
    id = "HTFAlignmentConstraint";
    evaluate(ctx) {
      const { trendState } = ctx;
      if (!trendState.htfAlignment) {
        return {
          passed: false,
          confidenceImpact: 0,
          reason: "Current timeframe direction does not align with Higher Time Frame (HTF) trend."
        };
      }
      return {
        passed: true,
        confidenceImpact: trendState.strength > 60 ? 20 : 10,
        reason: "HTF Alignment confirmed."
      };
    }
  };

  // src/engine/AntigravityEngine.ts
  var AntigravityEngine = class {
    logger = EventLog.getInstance();
    stateMachine = new MarketStateMachine();
    regimeEngine = new MarketRegimeEngine();
    constraintEngine = new ConstraintEngine();
    probEngine = new ProbabilityCalibrationEngine();
    circuitBreakers = new CircuitBreakerEngine();
    safetyLayer = new ExecutionSafetyLayer();
    api = new ExplainabilityAPI();
    constructor() {
      this.constraintEngine.registerConstraint(new RegimeConstraint());
      this.constraintEngine.registerConstraint(new VolatilityConstraint());
      this.constraintEngine.registerConstraint(new LiquidityConstraint());
      this.constraintEngine.registerConstraint(new HTFAlignmentConstraint());
    }
    /**
     * Main evaluation loop. Can be run in shadow mode without triggering real trades.
     */
    evaluateTick(context, isShadowMode = true) {
      this.logger.append({
        type: "TickReceived",
        correlationId: context.symbol,
        payload: { price: context.currentPrice, spread: context.spread }
      });
      context.regime = this.regimeEngine.classify(context);
      const health = this.circuitBreakers.evaluateSystemHealth(context, this.logger.getEvents({ startTs: Date.now() - 6e4 }));
      if (health.halted) return;
      const decision = this.constraintEngine.evaluate(context);
      if (decision.tradeEligible && !isShadowMode) {
        const intendedDirection = context.trendState.direction === "UP" ? "LONG" : "SHORT";
        const safety = this.safetyLayer.validateExecution(context, intendedDirection, context.currentPrice);
        if (safety.safe) {
          console.log(`[EXECUTE] ${intendedDirection} @ ${safety.adjustedEntry}`);
        }
      }
    }
  };
  return __toCommonJS(AntigravityEngine_exports);
})();
//# sourceMappingURL=AntigravityEngine.bundle.js.map
