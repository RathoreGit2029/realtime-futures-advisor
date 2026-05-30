/**
 * Determinism and Replayability Tests
 *
 * Verifies the engine produces identical outputs for identical inputs,
 * that Bayesian statistics accumulate correctly, and that memory is bounded.
 */

import { AntigravityEngine } from '../engine/AntigravityEngine';
import { RawMarketInput, MarketContext, MarketRegime, MarketState } from '../engine/Types';
import { DeterministicTestClock } from '../engine/DeterministicClock';
import { EventLog } from '../engine/EventSourcing';

// Minimal raw context — matches exactly what background.js passes to evaluateMarket
const makeRawCtx = (overrides: Partial<RawMarketInput> = {}): RawMarketInput => ({
  timestamp: Date.now(),
  symbol: 'BTCUSDT',
  marketState: MarketState.EXECUTION_WINDOW,
  volatility: {
    atr: 100,
    isExpanding: true,
    isCompressing: false,
    historicalRank: 75
  },
  liquidityState: {
    hasSweep: true,
    sweepQuality: 80,
    recentSweepDirection: 'BULLISH'
  },
  trendState: {
    direction: 'UP',
    strength: 70,
    htfAlignment: true
  },
  sessionState: {
    currentSession: 'NEW_YORK',
    isOverlap: false,
    minutesIntoSession: 120
  },
  displacementQuality: 85,
  spread: 2.5,
  confidence: 50,
  currentPrice: 50000,
  ...overrides
});

beforeEach(() => {
  EventLog.resetInstance();
});

// ─── Determinism ────────────────────────────────────────────────────────────

describe('Determinism', () => {
  test('identical inputs produce identical outputs', () => {
    const engine = new AntigravityEngine();
    const ctx = makeRawCtx({ timestamp: 1000 });

    const r1 = engine.evaluateMarket(ctx);
    const r2 = engine.evaluateMarket(ctx);

    expect(r1.context.regime).toBe(r2.context.regime);
    expect(r1.context.confidence).toBe(r2.context.confidence);
    expect(r1.decision.tradeEligible).toBe(r2.decision.tradeEligible);
    expect(r1.decision.finalConfidence).toBe(r2.decision.finalConfidence);
    expect(r1.halted).toBe(r2.halted);
  });

  test('regime classification is deterministic', () => {
    const engine = new AntigravityEngine();

    // Trending conditions — isExpanding + strength > 60 + trade session
    const trending = makeRawCtx({
      timestamp: 1000,
      volatility: { atr: 100, isExpanding: true, isCompressing: false, historicalRank: 75 },
      trendState: { direction: 'UP', strength: 70, htfAlignment: true },
      sessionState: { currentSession: 'NEW_YORK', isOverlap: false, minutesIntoSession: 60 }
    });
    const r1 = engine.evaluateMarket(trending);
    const r2 = engine.evaluateMarket(trending);
    expect(r1.context.regime).toBe(MarketRegime.TRENDING);
    expect(r1.context.regime).toBe(r2.context.regime);

    // HIGH_VOLATILITY overrides trending (rank > 95)
    const highVol = makeRawCtx({
      timestamp: 1000,
      volatility: { atr: 100, isExpanding: true, isCompressing: false, historicalRank: 97 },
      trendState: { direction: 'UP', strength: 70, htfAlignment: true },
      sessionState: { currentSession: 'NEW_YORK', isOverlap: false, minutesIntoSession: 60 }
    });
    const r3 = engine.evaluateMarket(highVol);
    expect(r3.context.regime).toBe(MarketRegime.HIGH_VOLATILITY);
    // RegimeConstraint blocks HIGH_VOLATILITY
    expect(r3.decision.tradeEligible).toBe(false);
  });

  test('constraint evaluation order matches registration order', () => {
    const engine = new AntigravityEngine();
    const order = (engine as any).constraintEngine.getEvaluationOrder();
    expect(order[0]).toBe('RegimeConstraint');
    expect(order[1]).toBe('VolatilityConstraint');
    expect(order[2]).toBe('LiquidityConstraint');
    expect(order[3]).toBe('HTFAlignmentConstraint');
  });

  test('circuit breaker is deterministic with injected wall clock', () => {
    const engine = new AntigravityEngine();
    const cb = (engine as any).circuitBreakers;

    // timestamp = 1000, wallClock = 7000 → latency = 6000ms > 5000ms threshold
    const ctx = makeRawCtx({ timestamp: 1000 });
    // Build a full context so the CB receives the right type
    const fullCtx = engine.evaluateMarket(ctx).context;

    const h1 = cb.evaluateSystemHealth(fullCtx, [], 7000);
    const h2 = cb.evaluateSystemHealth(fullCtx, [], 7000);

    expect(h1.halted).toBe(true);
    expect(h1.breakerType).toBe('DATA_LATENCY');
    expect(h1.halted).toBe(h2.halted);
    expect(h1.breakerType).toBe(h2.breakerType);
    expect(h1.reason).toBe(h2.reason);
  });

  test('extreme volatility is blocked before constraints', () => {
    const engine = new AntigravityEngine();
    const ctx = makeRawCtx({
      timestamp: Date.now(),
      volatility: { atr: 100, isExpanding: true, isCompressing: false, historicalRank: 97 }
    });
    const result = engine.evaluateMarket(ctx);
    // historicalRank 97 > 95 → circuit breaker fires first (EXTREME_VOLATILITY)
    // then even if it passed, RegimeConstraint would also block HIGH_VOLATILITY
    expect(result.decision.tradeEligible).toBe(false);
    // Either the circuit breaker or the regime constraint blocked it
    const blocked = result.decision.failedConstraints.includes('CircuitBreaker') ||
                    result.decision.failedConstraints.includes('RegimeConstraint');
    expect(blocked).toBe(true);
  });

  test('context hash changes when any field changes', () => {
    const engine = new AntigravityEngine();
    const r1 = engine.evaluateMarket(makeRawCtx({ timestamp: 1000, currentPrice: 50000 }));
    const r2 = engine.evaluateMarket(makeRawCtx({ timestamp: 1000, currentPrice: 50001 }));
    expect(r1.context.deterministicHash).not.toBe(r2.context.deterministicHash);
  });
});

// ─── Bayesian Probability Engine ────────────────────────────────────────────

describe('Bayesian Probability Engine', () => {
  test('starts at 50% with Beta(2,2) prior', () => {
    const engine = new AntigravityEngine();
    const prob = (engine as any).probEngine;

    const est = prob.getCalibratedBaseConfidence(MarketRegime.TRENDING);
    expect(est.pointEstimate).toBe(50);
    expect(est.isReliable).toBe(false);
    expect(est.credibleInterval95[0]).toBeLessThan(50);
    expect(est.credibleInterval95[1]).toBeGreaterThan(50);
  });

  test('posterior shifts toward wins', () => {
    const engine = new AntigravityEngine();
    const prob = (engine as any).probEngine;

    // 10 wins, 0 losses → alpha=12, beta=2 → mean = 12/14 ≈ 85.7%
    for (let i = 0; i < 10; i++) {
      prob.recordTradeResult(MarketRegime.TRENDING, true);
    }
    const est = prob.getCalibratedBaseConfidence(MarketRegime.TRENDING);
    expect(est.pointEstimate).toBeGreaterThan(80);
    expect(est.effectiveSampleSize).toBe(10);
  });

  test('credible interval narrows as sample size grows', () => {
    const engine = new AntigravityEngine();
    const prob = (engine as any).probEngine;

    const before = prob.getCalibratedBaseConfidence(MarketRegime.TRENDING);
    const widthBefore = before.credibleInterval95[1] - before.credibleInterval95[0];

    for (let i = 0; i < 30; i++) {
      prob.recordTradeResult(MarketRegime.TRENDING, i % 2 === 0);
    }

    const after = prob.getCalibratedBaseConfidence(MarketRegime.TRENDING);
    const widthAfter = after.credibleInterval95[1] - after.credibleInterval95[0];

    expect(widthAfter).toBeLessThan(widthBefore);
    expect(after.isReliable).toBe(true);
  });

  test('state serialises and deserialises correctly', () => {
    const engine = new AntigravityEngine();
    const prob = (engine as any).probEngine;

    prob.recordTradeResult(MarketRegime.TRENDING, true);
    prob.recordTradeResult(MarketRegime.TRENDING, false);
    prob.recordTradeResult(MarketRegime.COMPRESSION, true);

    const serialised = prob.serializeState();

    const engine2 = new AntigravityEngine();
    const prob2 = (engine2 as any).probEngine;
    prob2.deserializeState(serialised);

    const est1 = prob.getCalibratedBaseConfidence(MarketRegime.TRENDING);
    const est2 = prob2.getCalibratedBaseConfidence(MarketRegime.TRENDING);

    expect(est2.pointEstimate).toBe(est1.pointEstimate);
    expect(est2.effectiveSampleSize).toBe(est1.effectiveSampleSize);
  });
});

// ─── Memory Safety ──────────────────────────────────────────────────────────

describe('Memory Safety', () => {
  test('event log stays within bounds under high load', () => {
    const clock = new DeterministicTestClock(1000);
    EventLog.resetInstance();
    const eventLog = EventLog.getInstance(clock);
    const engine = new AntigravityEngine();

    for (let i = 0; i < 5000; i++) {
      clock.advance(10);
      engine.evaluateMarket(makeRawCtx({ timestamp: clock.now() }));
    }

    const count = eventLog.getEventCount();
    const memory = eventLog.getMemoryUsage();

    expect(count).toBeLessThanOrEqual(10000);
    expect(memory).toBeLessThan(10000 * 2048);
  });
});
