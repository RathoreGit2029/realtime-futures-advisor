"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReplayEngine = exports.ReplayDivergenceError = void 0;
const AntigravityEngine_js_1 = require("./AntigravityEngine.js");
const DeterministicClock_js_1 = require("./DeterministicClock.js");
const EventSourcing_js_1 = require("./EventSourcing.js");
class ReplayDivergenceError extends Error {
    sequenceNumber;
    field;
    expected;
    received;
    constructor(sequenceNumber, field, expected, received, message) {
        super(message);
        this.sequenceNumber = sequenceNumber;
        this.field = field;
        this.expected = expected;
        this.received = received;
        this.name = 'ReplayDivergenceError';
    }
}
exports.ReplayDivergenceError = ReplayDivergenceError;
class ReplayEngine {
    /**
     * Replays a list of logged events through a clean engine instance.
     * Asserts bit-for-bit decision and state transition parity.
     * Throws ReplayDivergenceError if any mismatch is detected.
     */
    static replay(events) {
        if (events.length === 0) {
            return { eventsProcessed: 0, ticksEvaluated: 0, outcomesRecorded: 0, finalSequenceNumber: 0 };
        }
        // 1. Sort events by sequence number to guarantee strict execution order
        const sortedEvents = [...events].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
        // 2. Setup Replay Clock with the timestamps of all events
        const timestamps = sortedEvents.map(e => e.exchangeTimestamp);
        const replayClock = new DeterministicClock_js_1.ReplayClock(timestamps);
        // 3. Reset EventLog singleton with ReplayClock before engine instancing
        EventSourcing_js_1.EventLog.resetInstance();
        EventSourcing_js_1.EventLog.getInstance(replayClock);
        // 4. Instantiate a clean engine
        const engine = new AntigravityEngine_js_1.AntigravityEngine();
        let ticksEvaluated = 0;
        let outcomesRecorded = 0;
        let finalSeq = 0;
        // 5. Replay each event sequentially
        for (const event of sortedEvents) {
            finalSeq = event.sequenceNumber;
            replayClock.setTime(event.exchangeTimestamp);
            if (event.type === 'MarketEvaluationRecorded') {
                if (!event.marketContextSnapshot) {
                    throw new Error(`State error: MarketEvaluationRecorded event ${event.sequenceNumber} is missing marketContextSnapshot`);
                }
                ticksEvaluated++;
                // RawMarketInput shape from snapshot fields
                const rawInput = {
                    timestamp: event.marketContextSnapshot.timestamp,
                    symbol: event.marketContextSnapshot.symbol,
                    marketState: event.marketContextSnapshot.marketState,
                    volatility: event.marketContextSnapshot.volatility,
                    liquidityState: event.marketContextSnapshot.liquidityState,
                    trendState: event.marketContextSnapshot.trendState,
                    sessionState: event.marketContextSnapshot.sessionState,
                    displacementQuality: event.marketContextSnapshot.displacementQuality,
                    spread: event.marketContextSnapshot.spread,
                    orderbookDepth: event.marketContextSnapshot.orderbookDepth,
                    confidence: event.marketContextSnapshot.confidence,
                    currentPrice: event.marketContextSnapshot.currentPrice,
                    sequenceNumber: event.marketContextSnapshot.sequenceNumber,
                    regime: event.marketContextSnapshot.regime,
                    positionActive: event.marketContextSnapshot.positionActive
                };
                // Re-evaluate the tick through the engine path
                const result = engine.evaluateMarket(rawInput);
                const expectedPayload = event.payload;
                // Verify Halted parity
                if (result.halted !== expectedPayload.halted) {
                    throw new ReplayDivergenceError(event.sequenceNumber, 'halted', expectedPayload.halted, result.halted, `Halt mismatch at sequence ${event.sequenceNumber}. Expected: ${expectedPayload.halted}, Got: ${result.halted}`);
                }
                // Verify Halt Reason parity
                if (expectedPayload.haltReason && result.haltReason !== expectedPayload.haltReason) {
                    throw new ReplayDivergenceError(event.sequenceNumber, 'haltReason', expectedPayload.haltReason, result.haltReason, `Halt reason mismatch at sequence ${event.sequenceNumber}. Expected: "${expectedPayload.haltReason}", Got: "${result.haltReason}"`);
                }
                // Verify decision parity
                const expDecision = expectedPayload.decision;
                const resDecision = result.decision;
                if (resDecision.tradeEligible !== expDecision.tradeEligible) {
                    throw new ReplayDivergenceError(event.sequenceNumber, 'tradeEligible', expDecision.tradeEligible, resDecision.tradeEligible, `Trade eligibility mismatch at sequence ${event.sequenceNumber}. Expected: ${expDecision.tradeEligible}, Got: ${resDecision.tradeEligible}`);
                }
                if (resDecision.finalConfidence !== expDecision.finalConfidence) {
                    throw new ReplayDivergenceError(event.sequenceNumber, 'finalConfidence', expDecision.finalConfidence, resDecision.finalConfidence, `Final confidence mismatch at sequence ${event.sequenceNumber}. Expected: ${expDecision.finalConfidence}, Got: ${resDecision.finalConfidence}`);
                }
                // Compare failed constraint lists (order-independent)
                const expFailed = [...expDecision.failedConstraints].sort();
                const resFailed = [...resDecision.failedConstraints].sort();
                if (JSON.stringify(expFailed) !== JSON.stringify(resFailed)) {
                    throw new ReplayDivergenceError(event.sequenceNumber, 'failedConstraints', expDecision.failedConstraints, resDecision.failedConstraints, `Failed constraints list mismatch at sequence ${event.sequenceNumber}. Expected: [${expDecision.failedConstraints.join(', ')}], Got: [${resDecision.failedConstraints.join(', ')}]`);
                }
                // Compare passed constraint lists
                const expPassed = [...expDecision.passedConstraints].sort();
                const resPassed = [...resDecision.passedConstraints].sort();
                if (JSON.stringify(expPassed) !== JSON.stringify(resPassed)) {
                    throw new ReplayDivergenceError(event.sequenceNumber, 'passedConstraints', expDecision.passedConstraints, resDecision.passedConstraints, `Passed constraints list mismatch at sequence ${event.sequenceNumber}. Expected: [${expPassed.join(', ')}], Got: [${resPassed.join(', ')}]`);
                }
                // Compare decision hashes
                if (resDecision.deterministicHash !== expDecision.deterministicHash) {
                    throw new ReplayDivergenceError(event.sequenceNumber, 'deterministicHash', expDecision.deterministicHash, resDecision.deterministicHash, `Decision deterministic hash mismatch at sequence ${event.sequenceNumber}. Expected: ${expDecision.deterministicHash}, Got: ${resDecision.deterministicHash}`);
                }
            }
            else if (event.type === 'TradeResultRecorded') {
                outcomesRecorded++;
                const { regime, win, pnlPercent } = event.payload;
                // Re-inject the trade results to align Bayesian engine posteriors
                engine.probEngine.recordTradeResult(regime, win, pnlPercent);
            }
        }
        return {
            eventsProcessed: sortedEvents.length,
            ticksEvaluated,
            outcomesRecorded,
            finalSequenceNumber: finalSeq
        };
    }
}
exports.ReplayEngine = ReplayEngine;
