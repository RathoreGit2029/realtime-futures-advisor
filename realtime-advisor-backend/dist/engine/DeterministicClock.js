"use strict";
/**
 * Deterministic Clock Interface
 *
 * Provides deterministic time sources for replayable execution.
 * All time-dependent operations must use this interface instead of Date.now().
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReplayClock = exports.DeterministicTestClock = exports.SystemClock = void 0;
/**
 * Production Clock — delegates to Date.now() on every call.
 * Determinism is achieved by injecting the timestamp into MarketContext
 * from the WebSocket event, not from this clock.
 */
class SystemClock {
    sequenceNumber = 0;
    now() {
        return Date.now();
    }
    sequence() {
        return this.sequenceNumber++;
    }
    advance(_ms) {
        // No-op for production clock — time advances naturally
    }
    reset() {
        this.sequenceNumber = 0;
    }
}
exports.SystemClock = SystemClock;
/**
 * Deterministic Test Clock - Fully controlled for testing and replay
 */
class DeterministicTestClock {
    currentTime;
    sequenceNumber = 0;
    constructor(initialTime = 0) {
        this.currentTime = initialTime;
    }
    now() {
        return this.currentTime;
    }
    sequence() {
        return this.sequenceNumber++;
    }
    advance(ms) {
        this.currentTime += ms;
    }
    reset() {
        this.currentTime = 0;
        this.sequenceNumber = 0;
    }
    /** Set time to specific value */
    setTime(time) {
        this.currentTime = time;
    }
}
exports.DeterministicTestClock = DeterministicTestClock;
/**
 * Replay Clock - Recreates exact timing from event stream
 */
class ReplayClock {
    eventTimes;
    currentTime;
    initialTime;
    sequenceNumber = 0;
    constructor(eventTimestamps) {
        this.eventTimes = [...eventTimestamps].sort((a, b) => a - b);
        this.initialTime = this.eventTimes[0] ?? 0;
        this.currentTime = this.initialTime;
    }
    now() {
        return this.currentTime;
    }
    sequence() {
        return this.sequenceNumber++;
    }
    advance(ms) {
        this.currentTime += ms;
    }
    reset() {
        this.currentTime = this.initialTime;
        this.sequenceNumber = 0;
    }
    /** Check if more events available based on timestamps */
    hasMoreEvents(timestamp) {
        return this.eventTimes.some(t => t > timestamp);
    }
    /** Set time directly to a specific timestamp */
    setTime(timestamp) {
        this.currentTime = timestamp;
    }
}
exports.ReplayClock = ReplayClock;
