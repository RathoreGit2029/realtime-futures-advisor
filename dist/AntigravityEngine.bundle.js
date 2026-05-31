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
    EventLog: () => EventLog,
    ExecutionSafetyLayer: () => ExecutionSafetyLayer,
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
    MarketState2["ACTIVE_POSITION"] = "ACTIVE_POSITION";
    MarketState2["EXIT"] = "EXIT";
    MarketState2["NO_TRADE"] = "NO_TRADE";
    MarketState2["EXPANSION"] = "EXPANSION";
    MarketState2["REVERSAL"] = "REVERSAL";
    MarketState2["CHOPPY"] = "CHOPPY";
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
      orderbookImbalance: base.orderbookImbalance,
      confidence: base.confidence,
      currentPrice: base.currentPrice,
      positionActive: base.positionActive,
      portfolioTrades: base.portfolioTrades,
      portfolioWalletBalance: base.portfolioWalletBalance,
      prospectiveTrade: base.prospectiveTrade,
      maxSpreadPct: base.maxSpreadPct,
      sweepLookback: base.sweepLookback,
      sweepWickRatio: base.sweepWickRatio,
      kellyFactor: base.kellyFactor,
      maxPortfolioHeat: base.maxPortfolioHeat,
      maxPortfolioMargin: base.maxPortfolioMargin,
      displacementScore: base.displacementScore,
      sweptPoolType: base.sweptPoolType,
      sweptPoolPrice: base.sweptPoolPrice,
      mssPrice: base.mssPrice,
      fvgTop: base.fvgTop,
      fvgBottom: base.fvgBottom,
      dealingRangeHigh: base.dealingRangeHigh,
      dealingRangeLow: base.dealingRangeLow,
      equilibrium: base.equilibrium,
      primaryTarget: base.primaryTarget,
      secondaryTarget: base.secondaryTarget
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

  // src/execution/SafetyLayer.ts
  var ExecutionSafetyLayer = class {
    /**
     * Validates if a trade is safe to execute and calculates slippage penalties.
     */
    validateExecution(ctx, direction, entryPrice) {
      const { volatility, spread, currentPrice } = ctx;
      const atrValue = volatility.atr || 0.1;
      const deviation = Math.abs(currentPrice - entryPrice);
      const maxDeviation = atrValue * 0.05;
      if (deviation > maxDeviation) {
        return {
          safe: false,
          adjustedEntryPrice: entryPrice,
          slippagePenalized: 0,
          reason: `Stale Tick Gate: Price drifted too far. Deviation=${deviation.toFixed(4)}, Max Allowed=${maxDeviation.toFixed(4)}`
        };
      }
      const slippagePenalized = spread * 1.5;
      const adjustedEntryPrice = direction === "LONG" ? currentPrice + slippagePenalized : currentPrice - slippagePenalized;
      return {
        safe: true,
        adjustedEntryPrice,
        slippagePenalized
      };
    }
  };

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
    static MAX_MEMORY_EVENTS = 1e4;
    static KEEP_EVENTS_COUNT = 5e3;
    events = [];
    lastEventHash = "";
    sequenceCounter = 0;
    clock;
    stateGetter;
    stateRestorer;
    constructor(clock) {
      this.clock = clock;
    }
    getClock() {
      return this.clock;
    }
    registerStateGetter(getter) {
      this.stateGetter = getter;
    }
    registerStateRestorer(restorer) {
      this.stateRestorer = restorer;
    }
    /**
     * Append a new deterministic event to the log
     */
    append(type, correlationId, payload, marketContextSnapshot) {
      const timestamp = this.clock.now();
      const sequenceNumber = this.sequenceCounter;
      if (this.events.length > 0) {
        const last = this.events[this.events.length - 1];
        if (sequenceNumber !== last.sequenceNumber + 1) {
          throw new Error(`State violation: Sequence jump detected. Expected: ${last.sequenceNumber + 1}, Got: ${sequenceNumber}`);
        }
      }
      const eventId = `${correlationId}-${sequenceNumber}`;
      const event = createSystemEvent({
        exchangeTimestamp: timestamp,
        receiveTimestamp: Date.now(),
        sequenceNumber,
        eventId,
        correlationId,
        type,
        payload,
        marketContextSnapshot,
        eventVersion: 1,
        previousEventHash: this.lastEventHash
      });
      this.events.push(event);
      this.sequenceCounter++;
      this.lastEventHash = event.deterministicHash;
      this.postEventToBackend(event);
      if (sequenceNumber > 0 && sequenceNumber % 1e4 === 0) {
        this.triggerSnapshotCheckpoint(sequenceNumber);
      }
      this.manageMemoryBounds();
      return event;
    }
    manageMemoryBounds() {
      if (this.events.length > _DeterministicEventLog.MAX_MEMORY_EVENTS) {
        this.events = this.events.slice(-_DeterministicEventLog.KEEP_EVENTS_COUNT);
      }
    }
    postEventToBackend(event) {
      if (typeof fetch === "undefined") return;
      fetch("http://localhost:4000/api/advisor/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event)
      }).then((res) => {
        if (!res.ok) {
          console.warn(`[Event Store] Failed to sync event ${event.sequenceNumber}: ${res.status}`);
        }
      }).catch((err) => {
        console.warn(`[Event Store] Backend unreachable for event ${event.sequenceNumber}:`, err.message);
      });
    }
    triggerSnapshotCheckpoint(sequenceNumber) {
      if (typeof fetch === "undefined" || !this.stateGetter) return;
      try {
        const stateData = this.stateGetter();
        fetch("http://localhost:4000/api/advisor/snapshots", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sequenceNumber,
            stateData,
            timestamp: Date.now()
          })
        }).then((res) => {
          if (res.ok) {
            console.log(`[Event Store] Snapshot checkpoint created at sequence ${sequenceNumber}`);
          }
        }).catch(() => {
        });
      } catch (e) {
        console.error("[Event Store] Checkpoint snapshot generation failed:", e);
      }
    }
    /**
     * Hydrates the Event Log from the SQLite backend store
     */
    async hydrate() {
      if (typeof fetch === "undefined") return;
      try {
        const snapshotRes = await fetch("http://localhost:4000/api/advisor/snapshots/latest");
        let startSeq = 0;
        let stateData = null;
        if (snapshotRes.ok) {
          const snapshot = await snapshotRes.json();
          if (snapshot && typeof snapshot.sequenceNumber === "number") {
            startSeq = snapshot.sequenceNumber + 1;
            stateData = snapshot.stateData;
            console.log(`[Event Store] Hydrating from latest snapshot at sequence ${snapshot.sequenceNumber}`);
          }
        }
        const eventsRes = await fetch(`http://localhost:4000/api/advisor/events?fromSequence=${startSeq}`);
        if (eventsRes.ok) {
          const events = await eventsRes.json();
          if (Array.isArray(events)) {
            if (events.length > 0) {
              console.log(`[Event Store] Hydrating and replaying ${events.length} events since sequence ${startSeq}`);
              this.events = events;
              const lastEvent = this.events[this.events.length - 1];
              this.sequenceCounter = lastEvent.sequenceNumber + 1;
              this.lastEventHash = lastEvent.deterministicHash;
            } else if (startSeq > 0) {
              this.events = [];
              this.sequenceCounter = startSeq;
            }
          }
        }
        if (stateData && this.stateRestorer) {
          this.stateRestorer(stateData);
        }
      } catch (err) {
        console.error("[Event Store] Hydration failed:", err.message);
      }
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
          filteredEvents = filteredEvents.filter((e) => e.exchangeTimestamp >= filter.startTimestamp);
        }
        if (filter.endTimestamp !== void 0) {
          filteredEvents = filteredEvents.filter((e) => e.exchangeTimestamp <= filter.endTimestamp);
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
        event.marketContextSnapshot
      );
    }
    async hydrate() {
      await this.eventLog.hydrate();
    }
    registerStateGetter(getter) {
      this.eventLog.registerStateGetter(getter);
    }
    registerStateRestorer(restorer) {
      this.eventLog.registerStateRestorer(restorer);
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
    getClock() {
      return this.eventLog.getClock();
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
    clock = this.logger.getClock();
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
      const startTime = this.clock.now();
      const individualEvaluations = [];
      const failedConstraints = [];
      const passedConstraints = [];
      const failureReasons = [];
      for (const constraint of this.constraints) {
        const evalStart = this.clock.now();
        const result = constraint.evaluate(context);
        const evaluationTime = this.clock.now() - evalStart;
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
            marketContextSnapshot: context
          });
          const totalEvaluationTime2 = this.clock.now() - startTime;
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
          marketContextSnapshot: context
        });
      }
      const totalEvaluationTime = this.clock.now() - startTime;
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
  var REGIME_PRIORS = {
    ["TRENDING" /* TRENDING */]: { alpha: 15, beta: 7 },
    // ~68.2% win rate
    ["MEAN_REVERTING" /* MEAN_REVERTING */]: { alpha: 13, beta: 8 },
    // ~61.9% win rate
    ["CHOPPY" /* CHOPPY */]: { alpha: 4, beta: 11 },
    // ~26.7% win rate
    ["EXPANSION" /* EXPANSION */]: { alpha: 12, beta: 8 },
    // 60.0% win rate
    ["COMPRESSION" /* COMPRESSION */]: { alpha: 2, beta: 2 },
    // neutral prior
    ["HIGH_VOLATILITY" /* HIGH_VOLATILITY */]: { alpha: 2, beta: 8 },
    // 20.0% win rate
    ["LOW_LIQUIDITY" /* LOW_LIQUIDITY */]: { alpha: 2, beta: 6 },
    // 25.0% win rate
    ["NEWS_EVENT" /* NEWS_EVENT */]: { alpha: 2, beta: 8 },
    // 20.0% win rate
    ["LIQUIDATION_CASCADE" /* LIQUIDATION_CASCADE */]: { alpha: 1, beta: 9 }
    // 10.0% win rate
  };
  var ProbabilityCalibrationEngine = class {
    stats;
    logger = EventLog.getInstance();
    constructor(restoredState) {
      this.stats = {};
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
    recordTradeResult(regime, win, pnlPercent) {
      const s = this.stats[regime];
      if (win) {
        s.alpha += 1;
      } else {
        s.beta += 1;
      }
      s.totalTrades += 1;
      s.lastUpdated = this.logger.getClock().now();
      this.logger.append({
        type: "TradeResultRecorded",
        correlationId: regime,
        payload: { regime, win, pnlPercent }
      });
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
        maxDataLatencyMs: 6e4,
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
      const startTime = this.eventLog.getClock().now() - timeWindowMs;
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
          time: new Date(e.receiveTimestamp).toISOString(),
          from: e.payload.from,
          to: e.payload.to,
          reason: e.payload.reason
        })),
        executionSafety: executionDecisions.length > 0 ? executionDecisions[executionDecisions.length - 1].payload : null
      };
    }
  };

  // src/engine/StateMachine.ts
  var VALID_TRANSITIONS = {
    ["NO_TRADE" /* NO_TRADE */]: /* @__PURE__ */ new Set([
      "NO_TRADE" /* NO_TRADE */,
      "ACCUMULATION" /* ACCUMULATION */,
      "LIQUIDITY_SWEEP" /* LIQUIDITY_SWEEP */,
      "DISPLACEMENT" /* DISPLACEMENT */,
      "RETRACEMENT" /* RETRACEMENT */,
      "EXECUTION_WINDOW" /* EXECUTION_WINDOW */
    ]),
    ["ACCUMULATION" /* ACCUMULATION */]: /* @__PURE__ */ new Set([
      "NO_TRADE" /* NO_TRADE */,
      "ACCUMULATION" /* ACCUMULATION */,
      "LIQUIDITY_SWEEP" /* LIQUIDITY_SWEEP */,
      "DISPLACEMENT" /* DISPLACEMENT */,
      "RETRACEMENT" /* RETRACEMENT */,
      "EXECUTION_WINDOW" /* EXECUTION_WINDOW */
    ]),
    ["LIQUIDITY_SWEEP" /* LIQUIDITY_SWEEP */]: /* @__PURE__ */ new Set([
      "NO_TRADE" /* NO_TRADE */,
      "ACCUMULATION" /* ACCUMULATION */,
      "LIQUIDITY_SWEEP" /* LIQUIDITY_SWEEP */,
      "DISPLACEMENT" /* DISPLACEMENT */,
      "EXECUTION_WINDOW" /* EXECUTION_WINDOW */
    ]),
    ["DISPLACEMENT" /* DISPLACEMENT */]: /* @__PURE__ */ new Set([
      "NO_TRADE" /* NO_TRADE */,
      "ACCUMULATION" /* ACCUMULATION */,
      "DISPLACEMENT" /* DISPLACEMENT */,
      "RETRACEMENT" /* RETRACEMENT */,
      "EXECUTION_WINDOW" /* EXECUTION_WINDOW */
    ]),
    ["RETRACEMENT" /* RETRACEMENT */]: /* @__PURE__ */ new Set([
      "NO_TRADE" /* NO_TRADE */,
      "ACCUMULATION" /* ACCUMULATION */,
      "RETRACEMENT" /* RETRACEMENT */,
      "EXECUTION_WINDOW" /* EXECUTION_WINDOW */
    ]),
    ["EXECUTION_WINDOW" /* EXECUTION_WINDOW */]: /* @__PURE__ */ new Set([
      "NO_TRADE" /* NO_TRADE */,
      "ACCUMULATION" /* ACCUMULATION */,
      "EXECUTION_WINDOW" /* EXECUTION_WINDOW */,
      "ACTIVE_POSITION" /* ACTIVE_POSITION */
    ]),
    ["ACTIVE_POSITION" /* ACTIVE_POSITION */]: /* @__PURE__ */ new Set([
      "NO_TRADE" /* NO_TRADE */,
      "ACTIVE_POSITION" /* ACTIVE_POSITION */,
      "EXIT" /* EXIT */
    ]),
    ["EXIT" /* EXIT */]: /* @__PURE__ */ new Set([
      "NO_TRADE" /* NO_TRADE */,
      "ACCUMULATION" /* ACCUMULATION */,
      "EXIT" /* EXIT */
    ]),
    // For compatibility with legacy states
    ["EXPANSION" /* EXPANSION */]: /* @__PURE__ */ new Set(["NO_TRADE" /* NO_TRADE */, "ACCUMULATION" /* ACCUMULATION */]),
    ["REVERSAL" /* REVERSAL */]: /* @__PURE__ */ new Set(["NO_TRADE" /* NO_TRADE */, "ACCUMULATION" /* ACCUMULATION */]),
    ["CHOPPY" /* CHOPPY */]: /* @__PURE__ */ new Set(["NO_TRADE" /* NO_TRADE */, "ACCUMULATION" /* ACCUMULATION */])
  };
  var StateMachine = class {
    symbolStates = /* @__PURE__ */ new Map();
    logger = EventLog.getInstance();
    getCurrentState(symbol) {
      return this.symbolStates.get(symbol) ?? "NO_TRADE" /* NO_TRADE */;
    }
    determineNextState(context, hasActivePosition) {
      if (hasActivePosition) {
        return "ACTIVE_POSITION" /* ACTIVE_POSITION */;
      }
      const currentState = this.getCurrentState(context.symbol);
      if (currentState === "ACTIVE_POSITION" /* ACTIVE_POSITION */ && !hasActivePosition) {
        return "EXIT" /* EXIT */;
      }
      if (currentState === "EXIT" /* EXIT */) {
        return "NO_TRADE" /* NO_TRADE */;
      }
      const isTradeSession = context.sessionState.currentSession === "LONDON" || context.sessionState.currentSession === "NEW_YORK" || context.sessionState.currentSession === "ASIA";
      if (!isTradeSession) {
        return "NO_TRADE" /* NO_TRADE */;
      }
      if (context.volatility.isCompressing && context.trendState.direction === "SIDEWAYS") {
        return "ACCUMULATION" /* ACCUMULATION */;
      }
      if (context.liquidityState.hasSweep) {
        return "LIQUIDITY_SWEEP" /* LIQUIDITY_SWEEP */;
      }
      if (context.displacementQuality > 75 && context.trendState.strength > 60) {
        return "DISPLACEMENT" /* DISPLACEMENT */;
      }
      if (context.trendState.direction !== "SIDEWAYS" && context.displacementQuality < 50) {
        return "RETRACEMENT" /* RETRACEMENT */;
      }
      if (context.marketState === "EXECUTION_WINDOW" /* EXECUTION_WINDOW */) {
        return "EXECUTION_WINDOW" /* EXECUTION_WINDOW */;
      }
      return "NO_TRADE" /* NO_TRADE */;
    }
    transitionTo(symbol, nextState, reason) {
      const currentState = this.getCurrentState(symbol);
      if (currentState === nextState) {
        return;
      }
      const isFirstTick = !this.symbolStates.has(symbol);
      if (isFirstTick) {
        this.symbolStates.set(symbol, nextState);
        this.logger.append({
          type: "StateTransition",
          correlationId: symbol,
          payload: {
            from: "INITIALIZING",
            to: nextState,
            reason: `Cold start initialization: ${reason}`
          }
        });
        console.log(`[FSM] ${symbol} initialized to ${nextState}. Reason: Cold start initialization`);
        return;
      }
      const validTransitions = VALID_TRANSITIONS[currentState];
      if (!validTransitions || !validTransitions.has(nextState)) {
        throw new Error(
          `State machine violation: Illegal transition attempt from ${currentState} to ${nextState} for symbol ${symbol}. Reason: ${reason}`
        );
      }
      this.symbolStates.set(symbol, nextState);
      this.logger.append({
        type: "StateTransition",
        correlationId: symbol,
        payload: {
          from: currentState,
          to: nextState,
          reason
        }
      });
      console.log(`[FSM] ${symbol} transitioned from ${currentState} -> ${nextState}. Reason: ${reason}`);
    }
    /** Force reset the state of a symbol (primarily for testing) */
    forceState(symbol, state) {
      this.symbolStates.set(symbol, state);
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

  // src/engine/CorrelationEngine.ts
  var CorrelationEngine = class {
    static matrix = {};
    static setMatrix(newMatrix) {
      this.matrix = newMatrix;
    }
    static getCorrelation(sym1, sym2) {
      if (sym1 === sym2) return 1;
      return this.matrix[sym1]?.[sym2] ?? 0;
    }
    /**
     * Calculates simple returns for a series of candles.
     * R_t = (Close_t - Close_{t-1}) / Close_{t-1}
     * For N candles, returns N-1 return values.
     */
    static calculateReturns(candles) {
      const returns = [];
      for (let i = 1; i < candles.length; i++) {
        const prevClose = candles[i - 1].close;
        if (prevClose === 0) {
          returns.push(0);
        } else {
          returns.push((candles[i].close - prevClose) / prevClose);
        }
      }
      return returns;
    }
    /**
     * Computes Pearson correlation coefficient between two return series.
     * Minimum length for correlation is 2. Defaults to 0 if not enough data or zero variance.
     */
    static calculatePearsonCorrelation(x, y) {
      const len = Math.min(x.length, y.length);
      if (len < 2) return 0;
      const xs = x.slice(-len);
      const ys = y.slice(-len);
      const xMean = xs.reduce((a, b) => a + b, 0) / len;
      const yMean = ys.reduce((a, b) => a + b, 0) / len;
      let num = 0;
      let denX = 0;
      let denY = 0;
      for (let i = 0; i < len; i++) {
        const diffX = xs[i] - xMean;
        const diffY = ys[i] - yMean;
        num += diffX * diffY;
        denX += diffX * diffX;
        denY += diffY * diffY;
      }
      if (denX === 0 || denY === 0) {
        return 0;
      }
      return num / Math.sqrt(denX * denY);
    }
    /**
     * Returns a map of symbol-to-symbol correlation values.
     * Represented as a Record<string, Record<string, number>>.
     */
    static calculateCorrelationMatrix(symbolCandles, windowSize = 50) {
      const matrix = {};
      const symbols = Object.keys(symbolCandles);
      const returnSeries = {};
      for (const sym of symbols) {
        const allCandles = symbolCandles[sym] || [];
        const closedCandles = allCandles.slice(0, -1).slice(-windowSize);
        if (closedCandles.length >= 2) {
          returnSeries[sym] = this.calculateReturns(closedCandles);
        } else {
          returnSeries[sym] = [];
        }
      }
      for (const sym1 of symbols) {
        matrix[sym1] = {};
        for (const sym2 of symbols) {
          if (sym1 === sym2) {
            matrix[sym1][sym2] = 1;
          } else {
            matrix[sym1][sym2] = 0;
          }
        }
      }
      for (let i = 0; i < symbols.length; i++) {
        const sym1 = symbols[i];
        const r1 = returnSeries[sym1];
        if (!r1 || r1.length < 2) continue;
        for (let j = i + 1; j < symbols.length; j++) {
          const sym2 = symbols[j];
          const r2 = returnSeries[sym2];
          if (!r2 || r2.length < 2) continue;
          const corr = this.calculatePearsonCorrelation(r1, r2);
          matrix[sym1][sym2] = corr;
          matrix[sym2][sym1] = corr;
        }
      }
      return matrix;
    }
  };

  // src/constraints/PortfolioHeatConstraint.ts
  var PortfolioHeatConstraint = class {
    id = "PortfolioHeatConstraint";
    evaluate(ctx) {
      const walletBalance = ctx.portfolioWalletBalance || 1e3;
      const activeTrades = ctx.portfolioTrades || [];
      const allTrades = [];
      for (const trade of activeTrades) {
        const entryPrice = trade.entry || ctx.currentPrice;
        const weight = (trade.direction === "LONG" ? 1 : -1) * (trade.positionSize * entryPrice) / walletBalance;
        allTrades.push({
          symbol: trade.symbol,
          direction: trade.direction,
          positionSize: trade.positionSize,
          entryPrice,
          marginRequired: trade.marginRequired || 0,
          weight
        });
      }
      if (ctx.prospectiveTrade) {
        const pt = ctx.prospectiveTrade;
        const entry = ctx.currentPrice;
        const p = ctx.confidence / 100;
        const riskPerUnit = Math.abs(entry - pt.stopLoss);
        let R = 1.5;
        if (riskPerUnit > 0) {
          R = Math.abs(pt.target1 - entry) / riskPerUnit;
        }
        const kellyFactor = ctx.kellyFactor ?? 0.25;
        const rawKelly = R > 0 ? kellyFactor * ((p * R - (1 - p)) / R) : 0.025;
        const clampedKelly = Math.max(0.01, Math.min(0.1, rawKelly));
        const riskAmount = walletBalance * clampedKelly;
        const positionSize = riskPerUnit > 0 ? riskAmount / riskPerUnit : 0;
        if (positionSize > 0) {
          const lev = pt.leverage || 3;
          const marginRequired = positionSize * entry / lev;
          const weight = (pt.direction === "LONG" ? 1 : -1) * (positionSize * entry) / walletBalance;
          allTrades.push({
            symbol: ctx.symbol,
            direction: pt.direction,
            positionSize,
            entryPrice: entry,
            marginRequired,
            weight
          });
        }
      }
      if (allTrades.length === 0) {
        return {
          passed: true,
          confidenceImpact: 0,
          reason: "Portfolio is empty, heat and margin bounds are nominal."
        };
      }
      let totalMargin = 0;
      for (const trade of allTrades) {
        totalMargin += trade.marginRequired;
      }
      const marginRatio = totalMargin / walletBalance;
      const maxPortfolioMargin = ctx.maxPortfolioMargin ?? 0.3;
      if (marginRatio > maxPortfolioMargin) {
        return {
          passed: false,
          confidenceImpact: 0,
          reason: `Aggregate margin exceeds limit: ${(marginRatio * 100).toFixed(2)}% > ${(maxPortfolioMargin * 100).toFixed(2)}%`
        };
      }
      let doubleSum = 0;
      for (const t1 of allTrades) {
        for (const t2 of allTrades) {
          const rho = CorrelationEngine.getCorrelation(t1.symbol, t2.symbol);
          doubleSum += t1.weight * t2.weight * rho;
        }
      }
      const portfolioHeat = Math.sqrt(Math.max(0, doubleSum));
      const maxPortfolioHeat = ctx.maxPortfolioHeat ?? 0.15;
      if (portfolioHeat > maxPortfolioHeat) {
        return {
          passed: false,
          confidenceImpact: 0,
          reason: `Correlation-weighted portfolio heat exceeds limit: ${(portfolioHeat * 100).toFixed(2)}% > ${(maxPortfolioHeat * 100).toFixed(2)}%`,
          metadata: { portfolioHeat }
        };
      }
      return {
        passed: true,
        confidenceImpact: 0,
        reason: `Portfolio heat is within bounds: ${(portfolioHeat * 100).toFixed(2)}% (limit ${(maxPortfolioHeat * 100).toFixed(2)}%), margin is ${(marginRatio * 100).toFixed(2)}% (limit ${(maxPortfolioMargin * 100).toFixed(2)}%).`,
        metadata: { portfolioHeat }
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
    safetyLayer = new ExecutionSafetyLayer();
    api = new ExplainabilityAPI();
    stateMachine = new StateMachine();
    constructor() {
      this.constraintEngine.registerConstraint(new RegimeConstraint());
      this.constraintEngine.registerConstraint(new VolatilityConstraint());
      this.constraintEngine.registerConstraint(new LiquidityConstraint());
      this.constraintEngine.registerConstraint(new HTFAlignmentConstraint());
      this.constraintEngine.registerConstraint(new PortfolioHeatConstraint());
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
      let context = createMarketContext({
        ...rawContext,
        regime,
        confidence: probabilityEstimate.pointEstimate
      });
      const hasActivePosition = !!rawContext.positionActive;
      const nextState = this.stateMachine.determineNextState(context, hasActivePosition);
      this.stateMachine.transitionTo(context.symbol, nextState, `Market evaluation tick for ${context.symbol}`);
      const validatedState = this.stateMachine.getCurrentState(context.symbol);
      context = createMarketContext({
        ...rawContext,
        regime,
        confidence: probabilityEstimate.pointEstimate,
        marketState: validatedState
      });
      const recentEvents = this.logger.getEvents({
        startTs: context.timestamp - 6e4,
        endTs: context.timestamp
      });
      const health = this.circuitBreakers.evaluateSystemHealth(
        context,
        recentEvents,
        this.logger.getClock().now()
      );
      if (health.halted) {
        const decision2 = {
          tradeEligible: false,
          failedConstraints: ["CircuitBreaker"],
          passedConstraints: [],
          failureReasons: [health.reason ?? "System halted"],
          finalConfidence: 0,
          individualEvaluations: [],
          totalEvaluationTime: 0,
          deterministicHash: ""
        };
        this.logger.append({
          type: "MarketEvaluationRecorded",
          correlationId: context.symbol,
          payload: {
            decision: decision2,
            halted: true,
            haltReason: health.reason
          },
          marketContextSnapshot: context
        });
        return {
          context,
          decision: decision2,
          halted: true,
          haltReason: health.reason
        };
      }
      const decision = this.constraintEngine.evaluate(context);
      this.logger.append({
        type: "MarketEvaluationRecorded",
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
          const evaluation = this.evaluateMarket(event.marketContextSnapshot);
          callback(evaluation, event);
        }
      }
    }
  };
  return __toCommonJS(AntigravityEngine_exports);
})();
