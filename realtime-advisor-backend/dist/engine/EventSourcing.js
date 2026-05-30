"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EventLog = void 0;
const DeterministicClock_js_1 = require("./DeterministicClock.js");
const DeterministicEventLog_js_1 = require("./DeterministicEventLog.js");
/**
 * EventLog singleton.
 *
 * The singleton is module-level, so it is reset on every service worker restart.
 * That is acceptable — the event log is an in-session audit trail, not a
 * persistence layer.  Cross-session persistence is handled by chrome.storage
 * (active trades, journal stats) and PostgreSQL (resolved signals).
 *
 * To inject a deterministic clock for testing, call EventLog.getInstance(clock)
 * BEFORE any other code creates the singleton.
 */
class EventLog {
    eventLog;
    static instance = null;
    constructor(clock) {
        this.eventLog = new DeterministicEventLog_js_1.DeterministicEventLog(clock);
    }
    static getInstance(clock) {
        if (!EventLog.instance) {
            EventLog.instance = new EventLog(clock ?? new DeterministicClock_js_1.SystemClock());
        }
        return EventLog.instance;
    }
    /** Reset singleton — only for tests */
    static resetInstance() {
        EventLog.instance = null;
    }
    append(event) {
        return this.eventLog.append(event.type, event.correlationId, event.payload, event.marketContextSnapshot);
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
    registerSyncEventHandler(handler) {
        this.eventLog.registerSyncEventHandler(handler);
    }
    registerSyncSnapshotHandler(handler) {
        this.eventLog.registerSyncSnapshotHandler(handler);
    }
    registerHydrationHandler(handler) {
        this.eventLog.registerHydrationHandler(handler);
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
}
exports.EventLog = EventLog;
