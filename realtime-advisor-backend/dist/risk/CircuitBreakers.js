"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CircuitBreakerEngine = void 0;
const EventSourcing_js_1 = require("../engine/EventSourcing.js");
class CircuitBreakerEngine {
    logger = EventSourcing_js_1.EventLog.getInstance();
    config;
    constructor(config) {
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
    evaluateSystemHealth(context, recentEvents, wallClockNow = Date.now()) {
        // Check 1: Extreme volatility — highest priority
        if (context.volatility.historicalRank > this.config.maxVolatilityRank) {
            return this.halt(`Volatility rank ${context.volatility.historicalRank} > ${this.config.maxVolatilityRank}`, 'EXTREME_VOLATILITY', 'HIGH');
        }
        // Check 2: Spread vs ATR — only meaningful with real spread data
        if (this.config.maxSpreadToAtrRatio !== Infinity &&
            context.volatility.atr > 0 &&
            context.spread > context.volatility.atr * this.config.maxSpreadToAtrRatio) {
            return this.halt(`Spread ${context.spread.toFixed(4)} > ${this.config.maxSpreadToAtrRatio * 100}% of ATR ${context.volatility.atr.toFixed(4)}`, 'SPREAD_EXPLOSION', 'HIGH');
        }
        // Check 3: Data latency — compare Binance event time against wall clock
        const latencyMs = wallClockNow - context.timestamp;
        if (latencyMs > this.config.maxDataLatencyMs) {
            return this.halt(`Data latency ${latencyMs}ms > ${this.config.maxDataLatencyMs}ms`, 'DATA_LATENCY', 'MEDIUM');
        }
        // Check 4: Execution rejection cascade
        const recentRejections = recentEvents.filter(e => e.type === 'ExecutionRejected');
        if (recentRejections.length > this.config.maxConsecutiveRejections) {
            return this.halt(`${recentRejections.length} consecutive execution rejections`, 'REJECTION_CASCADE', 'CRITICAL');
        }
        // Check 5: Sweep quality — only when a sweep is actually present
        // sweepQuality = 0 means no sweep detected, which is normal — do NOT halt on that
        if (context.liquidityState.hasSweep &&
            context.liquidityState.sweepQuality < this.config.minSweepQualityWhenSweepPresent) {
            return this.halt(`Sweep quality ${context.liquidityState.sweepQuality} < ${this.config.minSweepQualityWhenSweepPresent} (sweep present but weak)`, 'WEAK_SWEEP', 'LOW');
        }
        return { halted: false, severity: 'LOW' };
    }
    halt(reason, breakerType, severity) {
        this.logger.append({
            type: 'CircuitBreakerTriggered',
            correlationId: 'system',
            payload: { reason, breakerType, severity }
        });
        return { halted: true, reason, breakerType, severity };
    }
    getConfig() {
        return { ...this.config };
    }
}
exports.CircuitBreakerEngine = CircuitBreakerEngine;
