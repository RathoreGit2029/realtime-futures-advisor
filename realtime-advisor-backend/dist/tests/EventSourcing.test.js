"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const DeterministicEventLog_js_1 = require("../engine/DeterministicEventLog.js");
const DeterministicClock_js_1 = require("../engine/DeterministicClock.js");
const Types_js_1 = require("../engine/Types.js");
describe('Deterministic Event Sourcing', () => {
    let clock;
    let log;
    let mockFetch;
    beforeEach(() => {
        clock = new DeterministicClock_js_1.DeterministicTestClock(1000);
        log = new DeterministicEventLog_js_1.DeterministicEventLog(clock);
        mockFetch = jest.fn().mockImplementation(() => Promise.resolve({
            ok: true,
            json: () => Promise.resolve({})
        }));
        global.fetch = mockFetch;
    });
    afterEach(() => {
        jest.restoreAllMocks();
    });
    const makeMockMarketContext = (seq = 0) => ({
        timestamp: clock.now(),
        sequenceNumber: seq,
        symbol: 'BTCUSDT',
        regime: Types_js_1.MarketRegime.TRENDING,
        marketState: Types_js_1.MarketState.EXECUTION_WINDOW,
        volatility: { atr: 100, isExpanding: true, isCompressing: false, historicalRank: 50 },
        liquidityState: { hasSweep: false, sweepQuality: 0, recentSweepDirection: null },
        trendState: { direction: 'UP', strength: 50, htfAlignment: true },
        sessionState: { currentSession: 'NEW_YORK', isOverlap: false, minutesIntoSession: 0 },
        displacementQuality: 50,
        spread: 1.0,
        confidence: 50,
        currentPrice: 50000,
        deterministicHash: `context-hash-${seq}`
    });
    test('appends events sequentially and links hashes cryptographically', () => {
        const ctx0 = makeMockMarketContext(0);
        const event0 = log.append('MARKET_TICK', 'corr-1', { price: 50000 }, ctx0);
        expect(event0.sequenceNumber).toBe(0);
        expect(event0.previousEventHash).toBe('');
        expect(event0.deterministicHash).toBeDefined();
        expect(event0.type).toBe('MARKET_TICK');
        clock.advance(100);
        const ctx1 = makeMockMarketContext(1);
        const event1 = log.append('ORDER_FILL', 'corr-2', { fillPrice: 50001 }, ctx1);
        expect(event1.sequenceNumber).toBe(1);
        expect(event1.previousEventHash).toBe(event0.deterministicHash);
        expect(event1.deterministicHash).toBeDefined();
        expect(event1.deterministicHash).not.toBe(event0.deterministicHash);
        // Verify REST API was called
        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(mockFetch).toHaveBeenNthCalledWith(1, 'http://localhost:4000/api/advisor/events', expect.objectContaining({
            method: 'POST',
            body: expect.stringContaining(event0.deterministicHash)
        }));
    });
    test('fails if sequence number jumps or gets out of sync', () => {
        const ctx = makeMockMarketContext(0);
        log.append('MARKET_TICK', 'corr-1', {}, ctx);
        // Manually corrupt sequence state in log to simulate out of sync sequence
        log.sequenceCounter = 5; // Expected should be 1
        expect(() => {
            log.append('MARKET_TICK', 'corr-2', {}, ctx);
        }).toThrow(/State violation: Sequence jump detected/);
    });
    test('replayFrom performs strict chain verification', () => {
        const ctx = makeMockMarketContext(0);
        const event0 = log.append('MARKET_TICK', 'corr-1', {}, ctx);
        const event1 = log.append('MARKET_TICK', 'corr-2', {}, ctx);
        const replayed = [];
        log.replayFrom(0, (e) => replayed.push(e));
        expect(replayed).toHaveLength(2);
        expect(replayed[0].sequenceNumber).toBe(0);
        expect(replayed[1].sequenceNumber).toBe(1);
        // Test corrupted chain replay (broken sequence continuity)
        const corruptedEvents = [
            event0,
            { ...event1, sequenceNumber: 3 } // Sequence gap
        ];
        expect(() => {
            log.verifyEventChain(corruptedEvents);
        }).toThrow(/Event chain broken at sequence/);
        // Test corrupted chain replay (broken hash link)
        const corruptedHashEvents = [
            event0,
            { ...event1, previousEventHash: 'corrupted-hash' } // Hash link broken
        ];
        expect(() => {
            log.verifyEventChain(corruptedHashEvents);
        }).toThrow(/Event hash chain broken at sequence/);
    });
    test('triggers snapshot checkpoints on boundaries', () => {
        const stateMock = { test: 123 };
        log.registerStateGetter(() => stateMock);
        // Simulate appending many events. We can call triggerSnapshotCheckpoint manually or change counter
        // For unit testing triggerSnapshotCheckpoint directly:
        log.triggerSnapshotCheckpoint(10000);
        expect(mockFetch).toHaveBeenCalledTimes(1);
        const call = mockFetch.mock.calls[0];
        expect(call[0]).toBe('http://localhost:4000/api/advisor/snapshots');
        expect(call[1].method).toBe('POST');
        const parsedBody = JSON.parse(call[1].body);
        expect(parsedBody.sequenceNumber).toBe(10000);
        expect(parsedBody.stateData).toEqual(stateMock);
        expect(typeof parsedBody.timestamp).toBe('number');
    });
    test('hydrates correctly from latest snapshot and fetches trailing events', async () => {
        const stateMock = { test: 'recovered-state' };
        const mockRestorer = jest.fn();
        log.registerStateRestorer(mockRestorer);
        // Setup mock responses for snapshot and events
        mockFetch
            .mockImplementationOnce(() => Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
                sequenceNumber: 9999,
                stateData: stateMock,
                timestamp: 5000
            })
        })) // latest snapshot
            .mockImplementationOnce(() => Promise.resolve({
            ok: true,
            json: () => Promise.resolve([
                {
                    sequenceNumber: 10000,
                    exchangeTimestamp: 6000,
                    receiveTimestamp: 6005,
                    eventId: 'corr-3-10000',
                    correlationId: 'corr-3',
                    type: 'MARKET_TICK',
                    payload: {},
                    eventVersion: 1,
                    deterministicHash: 'hash-10000',
                    previousEventHash: 'hash-9999'
                }
            ])
        })); // events since sequence 10000
        await log.hydrate();
        expect(mockRestorer).toHaveBeenCalledWith(stateMock);
        expect(log.getEventCount()).toBe(1);
        expect(log.getReplayState().currentSequence).toBe(10001);
        expect(log.getReplayState().lastEventHash).toBe('hash-10000');
    });
});
