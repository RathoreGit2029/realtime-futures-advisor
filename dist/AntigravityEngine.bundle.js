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
    MarketState: () => MarketState,
    createMarketContext: () => createMarketContext,
    createSystemEvent: () => createSystemEvent
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
  function deterministicHashOf(input) {
    let h = 5381;
    for (let i = 0; i < input.length; i++) {
      h = (h << 5) + h ^ input.charCodeAt(i);
      h = h >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  }
  function createMarketContext(base) {
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
      currentPrice: base.currentPrice
    });
    return {
      ...base,
      sequenceNumber,
      deterministicHash: deterministicHashOf(hashInput)
    };
  }
  function createSystemEvent(base) {
    const sequenceNumber = base.sequenceNumber ?? 0;
    const hashInput = JSON.stringify({
      timestamp: base.timestamp,
      sequenceNumber,
      eventId: base.eventId,
      correlationId: base.correlationId,
      type: base.type,
      payload: base.payload,
      previousEventHash: base.previousEventHash
    });
    return {
      ...base,
      sequenceNumber,
      deterministicHash: deterministicHashOf(hashInput),
      previousEventHash: base.previousEventHash
    };
  }

  // src/engine/DeterministicClock.ts
  var SystemClock = class {
    sequenceNumber = 0;
    now() {
      return Date.now();
    }
    sequence() {
      return this.sequenceNumber++;
    }
    advance(_ms) {
    }
    reset() {
      this.sequenceNumber = 0;
    }
  };

  // src/engine/DeterministicEventLog.ts
  var DeterministicEventLog = class _DeterministicEventLog {
    events = [];
    lastEventHash = "";
    sequenceCounter = 0;
    clock;
    /** Maximum events in memory (archived events are persisted) */
    static MAX_MEMORY_EVENTS = 1e4;
    /** Archive threshold - when to start archiving old events */
    static ARCHIVE_THRESHOLD = 5e3;
    constructor(clock) {
      this.clock = clock;
    }
    /**
     * Append a new deterministic event to the log
     */
    append(type, correlationId, payload, marketSnapshot) {
      const timestamp = this.clock.now();
      const sequenceNumber = this.sequenceCounter++;
      const eventId = `${correlationId}-${sequenceNumber}`;
      const event = createSystemEvent({
        timestamp,
        sequenceNumber,
        eventId,
        correlationId,
        type,
        payload,
        marketSnapshot,
        previousEventHash: this.lastEventHash
      });
      this.events.push(event);
      this.lastEventHash = event.deterministicHash;
      this.manageMemoryBounds();
      return event;
    }
    /**
     * Get events with deterministic filtering
     */
    getEvents(filter) {
      let filteredEvents = this.events;
      if (filter) {
        if (filter.startSequence !== void 0) {
          filteredEvents = filteredEvents.filter((e) => e.sequenceNumber >= filter.startSequence);
        }
        if (filter.endSequence !== void 0) {
          filteredEvents = filteredEvents.filter((e) => e.sequenceNumber <= filter.endSequence);
        }
        if (filter.startTimestamp !== void 0) {
          filteredEvents = filteredEvents.filter((e) => e.timestamp >= filter.startTimestamp);
        }
        if (filter.endTimestamp !== void 0) {
          filteredEvents = filteredEvents.filter((e) => e.timestamp <= filter.endTimestamp);
        }
        if (filter.correlationId) {
          filteredEvents = filteredEvents.filter((e) => e.correlationId === filter.correlationId);
        }
        if (filter.eventType) {
          filteredEvents = filteredEvents.filter((e) => e.type === filter.eventType);
        }
      }
      const startSequence = filteredEvents.length > 0 ? filteredEvents[0].sequenceNumber : 0;
      const endSequence = filteredEvents.length > 0 ? filteredEvents[filteredEvents.length - 1].sequenceNumber : 0;
      return {
        events: [...filteredEvents],
        startSequence,
        endSequence,
        totalEvents: filteredEvents.length
      };
    }
    /**
     * Get event by sequence number (deterministic)
     */
    getEvent(sequenceNumber) {
      return this.events.find((e) => e.sequenceNumber === sequenceNumber);
    }
    /**
     * Get current replay state
     */
    getReplayState() {
      return {
        currentSequence: this.sequenceCounter,
        lastEventHash: this.lastEventHash,
        totalEventsProcessed: this.events.length
      };
    }
    /**
     * Replay events from a specific sequence number
     */
    replayFrom(sequenceNumber, callback) {
      const eventsToReplay = this.events.filter((e) => e.sequenceNumber >= sequenceNumber);
      this.verifyEventChain(eventsToReplay);
      eventsToReplay.forEach(callback);
    }
    /**
     * Verify event chain integrity
     */
    verifyEventChain(events) {
      if (events.length === 0) return true;
      const sortedEvents = [...events].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
      for (let i = 1; i < sortedEvents.length; i++) {
        if (sortedEvents[i].sequenceNumber !== sortedEvents[i - 1].sequenceNumber + 1) {
          throw new Error(`Event chain broken at sequence ${sortedEvents[i - 1].sequenceNumber}`);
        }
        if (sortedEvents[i].previousEventHash !== sortedEvents[i - 1].deterministicHash) {
          throw new Error(`Event hash chain broken at sequence ${sortedEvents[i].sequenceNumber}`);
        }
      }
      return true;
    }
    /**
     * Manage memory bounds by archiving old events
     */
    manageMemoryBounds() {
      if (this.events.length > _DeterministicEventLog.MAX_MEMORY_EVENTS) {
        const eventsToKeep = this.events.slice(-_DeterministicEventLog.ARCHIVE_THRESHOLD);
        this.events = eventsToKeep;
        if (this.events.length > 0) {
          this.lastEventHash = this.events[this.events.length - 1].deterministicHash;
        }
      }
    }
    /**
     * Clear all events (for testing)
     */
    clear() {
      this.events = [];
      this.lastEventHash = "";
      this.sequenceCounter = 0;
    }
    /**
     * Get total event count
     */
    getEventCount() {
      return this.events.length;
    }
    /**
     * Get memory usage estimate
     */
    getMemoryUsage() {
      const avgEventSize = 1024;
      return this.events.length * avgEventSize;
    }
  };

  // src/engine/EventSourcing.ts
  var EventLog = class _EventLog {
    eventLog;
    static instance = null;
    constructor(clock) {
      this.eventLog = new DeterministicEventLog(clock);
    }
    static getInstance(clock) {
      if (!_EventLog.instance) {
        _EventLog.instance = new _EventLog(clock ?? new SystemClock());
      }
      return _EventLog.instance;
    }
    /** Reset singleton — only for tests */
    static resetInstance() {
      _EventLog.instance = null;
    }
    append(event) {
      return this.eventLog.append(
        event.type,
        event.correlationId,
        event.payload,
        event.marketSnapshot
      );
    }
    getEvents(filter) {
      return this.eventLog.getEvents({
        startTimestamp: filter?.startTs,
        endTimestamp: filter?.endTs,
        correlationId: filter?.correlationId,
        startSequence: filter?.startSequence,
        endSequence: filter?.endSequence,
        eventType: filter?.eventType
      }).events;
    }
    replayFrom(sequenceNumber, callback) {
      this.eventLog.replayFrom(sequenceNumber, callback);
    }
    getReplayState() {
      return this.eventLog.getReplayState();
    }
    clear() {
      this.eventLog.clear();
    }
    getEventCount() {
      return this.eventLog.getEventCount();
    }
    getMemoryUsage() {
      return this.eventLog.getMemoryUsage();
    }
  };

  // src/engine/MarketRegimeEngine.ts
  var MarketRegimeEngine = class {
    logger = EventLog.getInstance();
    /**
     * Classify regime from a full MarketContext.
     * Used internally after context is built.
     */
    classify(context) {
      return this.classifyRaw(context);
    }
    /**
     * Classify regime from a partial context object.
     * Called by AntigravityEngine before the full immutable context is assembled,
     * and directly from background.js via the engine bundle.
     *
     * Rules are evaluated in priority order — first match wins.
     */
    classifyRaw(inputs) {
      const { volatility, trendState, sessionState } = inputs;
      const isTradeSession = sessionState.currentSession === "LONDON" || sessionState.currentSession === "NEW_YORK" || sessionState.currentSession === "ASIA";
      let newRegime;
      if (volatility.historicalRank > 95) {
        newRegime = "HIGH_VOLATILITY" /* HIGH_VOLATILITY */;
      } else if (isTradeSession && volatility.isExpanding && trendState.strength > 60) {
        newRegime = "TRENDING" /* TRENDING */;
      } else if (volatility.isCompressing && trendState.strength < 30) {
        newRegime = "COMPRESSION" /* COMPRESSION */;
      } else if (trendState.direction === "SIDEWAYS" && volatility.atr > 0) {
        newRegime = "MEAN_REVERTING" /* MEAN_REVERTING */;
      } else {
        newRegime = "CHOPPY" /* CHOPPY */;
      }
      const previousRegime = inputs.regime;
      if (previousRegime !== void 0 && previousRegime !== newRegime) {
        this.logger.append({
          type: "RegimeChanged",
          correlationId: inputs.symbol,
          payload: {
            from: previousRegime,
            to: newRegime,
            volatilityRank: volatility.historicalRank,
            trendStrength: trendState.strength,
            session: sessionState.currentSession
          }
        });
      }
      return newRegime;
    }
    /**
     * Returns the classification with a full explanation of which rule fired.
     */
    explainClassification(inputs) {
      const { volatility, trendState, sessionState } = inputs;
      const isTradeSession = sessionState.currentSession === "LONDON" || sessionState.currentSession === "NEW_YORK" || sessionState.currentSession === "ASIA";
      let regime;
      let ruleFired;
      if (volatility.historicalRank > 95) {
        regime = "HIGH_VOLATILITY" /* HIGH_VOLATILITY */;
        ruleFired = "volatilityRank > 95";
      } else if (isTradeSession && volatility.isExpanding && trendState.strength > 60) {
        regime = "TRENDING" /* TRENDING */;
        ruleFired = "tradeSession && isExpanding && strength > 60";
      } else if (volatility.isCompressing && trendState.strength < 30) {
        regime = "COMPRESSION" /* COMPRESSION */;
        ruleFired = "isCompressing && strength < 30";
      } else if (trendState.direction === "SIDEWAYS" && volatility.atr > 0) {
        regime = "MEAN_REVERTING" /* MEAN_REVERTING */;
        ruleFired = "direction === SIDEWAYS && atr > 0";
      } else {
        regime = "CHOPPY" /* CHOPPY */;
        ruleFired = "default";
      }
      return {
        regime,
        ruleFired,
        inputs: {
          volatilityRank: volatility.historicalRank,
          isExpanding: volatility.isExpanding,
          isCompressing: volatility.isCompressing,
          trendStrength: trendState.strength,
          trendDirection: trendState.direction,
          isTradeSession
        }
      };
    }
  };

  // src/engine/ConstraintEngine.ts
  function hashString(input) {
    let h = 5381;
    for (let i = 0; i < input.length; i++) {
      h = (h << 5) + h ^ input.charCodeAt(i);
      h = h >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  }
  var ConstraintEngine = class {
    constraints = [];
    logger = EventLog.getInstance();
    /**
     * Register a constraint. Constraints are evaluated in registration order.
     * Order is intentional: cheap/broad gates first, expensive/narrow gates last.
     * Do NOT sort — registration order is the contract.
     */
    registerConstraint(constraint) {
      this.constraints.push(constraint);
    }
    /**
     * Evaluate all constraints in registration order.
     * Short-circuits on first failure.
     * finalConfidence is the Bayesian point estimate from context — never synthesised here.
     */
    evaluate(context) {
      const startTime = Date.now();
      const individualEvaluations = [];
      const failedConstraints = [];
      const passedConstraints = [];
      const failureReasons = [];
      for (const constraint of this.constraints) {
        const evalStart = Date.now();
        const result = constraint.evaluate(context);
        const evaluationTime = Date.now() - evalStart;
        individualEvaluations.push({
          constraintId: constraint.id,
          passed: result.passed,
          reason: result.reason,
          confidenceImpact: result.confidenceImpact,
          metadata: result.metadata,
          evaluationTime
        });
        if (!result.passed) {
          failedConstraints.push(constraint.id);
          failureReasons.push(result.reason);
          this.logger.append({
            type: "ConstraintRejected",
            correlationId: context.symbol,
            payload: { constraintId: constraint.id, reason: result.reason },
            marketSnapshot: context
          });
          const totalEvaluationTime2 = Date.now() - startTime;
          return {
            tradeEligible: false,
            failedConstraints,
            passedConstraints,
            failureReasons,
            finalConfidence: 0,
            individualEvaluations,
            totalEvaluationTime: totalEvaluationTime2,
            deterministicHash: this.decisionHash(context, individualEvaluations)
          };
        }
        passedConstraints.push(constraint.id);
        this.logger.append({
          type: "ConstraintPassed",
          correlationId: context.symbol,
          payload: { constraintId: constraint.id },
          marketSnapshot: context
        });
      }
      const totalEvaluationTime = Date.now() - startTime;
      const finalConfidence = Math.max(0, Math.min(100, context.confidence));
      return {
        tradeEligible: true,
        failedConstraints,
        passedConstraints,
        failureReasons,
        finalConfidence,
        individualEvaluations,
        totalEvaluationTime,
        deterministicHash: this.decisionHash(context, individualEvaluations)
      };
    }
    decisionHash(context, evaluations) {
      return hashString(JSON.stringify({
        ctxHash: context.deterministicHash,
        evals: evaluations.map((e) => ({ id: e.constraintId, passed: e.passed }))
      }));
    }
    getEvaluationOrder() {
      return this.constraints.map((c) => c.id);
    }
    getConstraintStatistics() {
      return {
        totalConstraints: this.constraints.length,
        evaluationOrder: this.getEvaluationOrder()
      };
    }
    // Keep for test compatibility
    validateEvaluationOrder() {
      return true;
    }
  };

  // src/engine/ProbabilityCalibration.ts
  var MIN_RELIABLE_SAMPLES = 20;
  var PRIOR_ALPHA = 2;
  var PRIOR_BETA = 2;
  var ProbabilityCalibrationEngine = class {
    stats;
    constructor(restoredState) {
      this.stats = {};
      for (const regime of Object.values(MarketRegime)) {
        const saved = restoredState?.[regime];
        this.stats[regime] = saved ?? {
          alpha: PRIOR_ALPHA,
          beta: PRIOR_BETA,
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
    getCalibratedBaseConfidence(regime) {
      const s = this.stats[regime];
      const n = s.alpha + s.beta;
      const mean = s.alpha / n;
      const variance = s.alpha * s.beta / (n * n * (n + 1));
      const stdDev = Math.sqrt(variance);
      const z = 1.96;
      const lower = Math.max(0, mean - z * stdDev) * 100;
      const upper = Math.min(1, mean + z * stdDev) * 100;
      return {
        pointEstimate: Math.round(mean * 1e3) / 10,
        // 1 decimal place
        credibleInterval95: [Math.round(lower * 10) / 10, Math.round(upper * 10) / 10],
        standardError: Math.round(stdDev * 1e3) / 10,
        effectiveSampleSize: s.totalTrades,
        isReliable: s.totalTrades >= MIN_RELIABLE_SAMPLES
      };
    }
    /**
     * Record a trade outcome and update the posterior.
     * pnlPercent is stored for future expectancy weighting but not used yet.
     */
    recordTradeResult(regime, win, _pnlPercent) {
      const s = this.stats[regime];
      if (win) {
        s.alpha += 1;
      } else {
        s.beta += 1;
      }
      s.totalTrades += 1;
      s.lastUpdated = Date.now();
    }
    /**
     * Serialise the full probability state for persistence in chrome.storage.
     * Call this after every recordTradeResult() and restore on SW startup.
     */
    serializeState() {
      const out = {};
      for (const regime of Object.values(MarketRegime)) {
        out[regime] = { ...this.stats[regime] };
      }
      return out;
    }
    /**
     * Replace the current state with a previously serialised snapshot.
     * Used on SW restart to restore accumulated learning.
     */
    deserializeState(state) {
      for (const regime of Object.values(MarketRegime)) {
        if (state[regime]) {
          this.stats[regime] = { ...state[regime] };
        }
      }
    }
    getRegimeStatistics(regime) {
      return { ...this.stats[regime] };
    }
    resetRegime(regime) {
      this.stats[regime] = {
        alpha: PRIOR_ALPHA,
        beta: PRIOR_BETA,
        totalTrades: 0,
        lastUpdated: 0
      };
    }
    getCalibrationQuality() {
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
  };

  // src/risk/CircuitBreakers.ts
  var CircuitBreakerEngine = class {
    logger = EventLog.getInstance();
    config;
    constructor(config) {
      this.config = {
        // Disabled by default because background.js uses a synthetic spread.
        // Enable and lower this threshold only when real order-book spread is available.
        maxSpreadToAtrRatio: Infinity,
        maxDataLatencyMs: 5e3,
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
    evaluateSystemHealth(context, recentEvents, wallClockNow = Date.now()) {
      if (context.volatility.historicalRank > this.config.maxVolatilityRank) {
        return this.halt(
          `Volatility rank ${context.volatility.historicalRank} > ${this.config.maxVolatilityRank}`,
          "EXTREME_VOLATILITY",
          "HIGH"
        );
      }
      if (this.config.maxSpreadToAtrRatio !== Infinity && context.volatility.atr > 0 && context.spread > context.volatility.atr * this.config.maxSpreadToAtrRatio) {
        return this.halt(
          `Spread ${context.spread.toFixed(4)} > ${this.config.maxSpreadToAtrRatio * 100}% of ATR ${context.volatility.atr.toFixed(4)}`,
          "SPREAD_EXPLOSION",
          "HIGH"
        );
      }
      const latencyMs = wallClockNow - context.timestamp;
      if (latencyMs > this.config.maxDataLatencyMs) {
        return this.halt(
          `Data latency ${latencyMs}ms > ${this.config.maxDataLatencyMs}ms`,
          "DATA_LATENCY",
          "MEDIUM"
        );
      }
      const recentRejections = recentEvents.filter((e) => e.type === "ExecutionRejected");
      if (recentRejections.length > this.config.maxConsecutiveRejections) {
        return this.halt(
          `${recentRejections.length} consecutive execution rejections`,
          "REJECTION_CASCADE",
          "CRITICAL"
        );
      }
      if (context.liquidityState.hasSweep && context.liquidityState.sweepQuality < this.config.minSweepQualityWhenSweepPresent) {
        return this.halt(
          `Sweep quality ${context.liquidityState.sweepQuality} < ${this.config.minSweepQualityWhenSweepPresent} (sweep present but weak)`,
          "WEAK_SWEEP",
          "LOW"
        );
      }
      return { halted: false, severity: "LOW" };
    }
    halt(reason, breakerType, severity) {
      this.logger.append({
        type: "CircuitBreakerTriggered",
        correlationId: "system",
        payload: { reason, breakerType, severity }
      });
      return { halted: true, reason, breakerType, severity };
    }
    getConfig() {
      return { ...this.config };
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
    constructor(allowedRegimes = [
      "TRENDING" /* TRENDING */,
      "COMPRESSION" /* COMPRESSION */,
      "MEAN_REVERTING" /* MEAN_REVERTING */,
      "CHOPPY" /* CHOPPY */
    ]) {
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
      return {
        passed: true,
        confidenceImpact: 0,
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
        confidenceImpact: 0,
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
        if (intendedTradeDirection === "UP" && liquidityState.recentSweepDirection === "BEARISH") {
          return {
            passed: false,
            confidenceImpact: 0,
            reason: "Sweep direction opposes logical entry. Swept highs, but looking for longs."
          };
        }
        if (intendedTradeDirection === "DOWN" && liquidityState.recentSweepDirection === "BULLISH") {
          return {
            passed: false,
            confidenceImpact: 0,
            reason: "Sweep direction opposes logical entry. Swept lows, but looking for shorts."
          };
        }
      }
      return {
        passed: true,
        confidenceImpact: 0,
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
        confidenceImpact: 0,
        reason: "HTF Alignment confirmed."
      };
    }
  };

  // src/engine/AntigravityEngine.ts
  var AntigravityEngine = class {
    logger = EventLog.getInstance();
    regimeEngine = new MarketRegimeEngine();
    constraintEngine = new ConstraintEngine();
    probEngine = new ProbabilityCalibrationEngine();
    circuitBreakers = new CircuitBreakerEngine();
    api = new ExplainabilityAPI();
    constructor() {
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
    evaluateMarket(rawContext) {
      const regime = this.regimeEngine.classifyRaw(rawContext);
      const probabilityEstimate = this.probEngine.getCalibratedBaseConfidence(regime);
      const context = createMarketContext({
        ...rawContext,
        regime,
        confidence: probabilityEstimate.pointEstimate
      });
      const recentEvents = this.logger.getEvents({
        startTs: context.timestamp - 6e4,
        endTs: context.timestamp
      });
      const health = this.circuitBreakers.evaluateSystemHealth(context, recentEvents);
      if (health.halted) {
        this.logger.append({
          type: "CircuitBreakerHalt",
          correlationId: context.symbol,
          payload: { reason: health.reason, breakerType: health.breakerType },
          marketSnapshot: context
        });
        return {
          context,
          decision: {
            tradeEligible: false,
            failedConstraints: ["CircuitBreaker"],
            passedConstraints: [],
            failureReasons: [health.reason ?? "System halted"],
            finalConfidence: 0,
            individualEvaluations: [],
            totalEvaluationTime: 0,
            deterministicHash: ""
          },
          halted: true,
          haltReason: health.reason
        };
      }
      const decision = this.constraintEngine.evaluate(context);
      return { context, decision, halted: false };
    }
    /**
     * Replay evaluations from the in-memory event log.
     * Only useful within the same service worker lifetime.
     */
    replayEvaluation(_initialContext, eventSequence, callback) {
      const events = this.logger.getEvents({ startSequence: eventSequence });
      for (const event of events) {
        if (event.marketSnapshot) {
          const evaluation = this.evaluateMarket(event.marketSnapshot);
          callback(evaluation, event);
        }
      }
    }
  };
  return __toCommonJS(AntigravityEngine_exports);
})();
