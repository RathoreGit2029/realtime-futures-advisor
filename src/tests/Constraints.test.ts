import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { RegimeConstraint } from '../constraints/RegimeConstraint';
import { VolatilityConstraint } from '../constraints/VolatilityConstraint';
import { LiquidityConstraint } from '../constraints/LiquidityConstraint';
import { MarketContext, MarketRegime, MarketState } from '../engine/Types';
import { ProbabilityCalibrationEngine } from '../engine/ProbabilityCalibration';
import { ReplayEngine } from '../engine/ReplayEngine';
import { EventLog } from '../engine/EventSourcing';

// Mock fetch globally to prevent network tests from hanging
(globalThis as any).fetch = jest.fn().mockImplementation(() =>
  Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ success: true }),
  })
) as any;

describe('Constraint DAG Unit Tests', () => {
  let defaultContext: MarketContext;

  beforeEach(() => {
    // Generate a fresh mock context for each test
    defaultContext = {
      timestamp: Date.now(),
      symbol: 'BTCUSDT',
      regime: MarketRegime.TRENDING,
      marketState: MarketState.EXECUTION_WINDOW,
      volatility: {
        atr: 100,
        isExpanding: false,
        isCompressing: false,
        historicalRank: 50
      },
      liquidityState: {
        hasSweep: true,
        sweepQuality: 85,
        recentSweepDirection: 'BEARISH'
      },
      trendState: {
        direction: 'UP',
        strength: 80,
        htfAlignment: true
      },
      sessionState: {
        currentSession: 'NEW_YORK',
        isOverlap: true,
        minutesIntoSession: 120
      },
      displacementQuality: 90,
      spread: 0.1,
      confidence: 50,
      currentPrice: 65000
    };
  });

  describe('RegimeConstraint', () => {
    it('should pass in a TRENDING regime with a positive confidence impact', () => {
      const constraint = new RegimeConstraint();
      const result = constraint.evaluate(defaultContext);
      expect(result.passed).toBe(true);
      expect(result.confidenceImpact).toBe(15);
    });

    it('should fail in an unallowed regime (e.g. LIQUIDATION_CASCADE)', () => {
      defaultContext.regime = MarketRegime.LIQUIDATION_CASCADE;
      const constraint = new RegimeConstraint();
      const result = constraint.evaluate(defaultContext);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('not in allowed list');
    });
  });

  describe('VolatilityConstraint', () => {
    it('should fail if historical rank > 95', () => {
      defaultContext.volatility.historicalRank = 98;
      const constraint = new VolatilityConstraint();
      const result = constraint.evaluate(defaultContext);
      expect(result.passed).toBe(false);
    });

    it('should fail if spread expands dangerously during volatility expansion', () => {
      defaultContext.volatility.isExpanding = true;
      defaultContext.spread = 15; // > 10% of ATR (100)
      const constraint = new VolatilityConstraint();
      const result = constraint.evaluate(defaultContext);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('Spread expansion detected');
    });
  });

  describe('LiquidityConstraint', () => {
    it('should fail if no sweep occurred before execution window', () => {
      defaultContext.liquidityState.hasSweep = false;
      const constraint = new LiquidityConstraint();
      const result = constraint.evaluate(defaultContext);
      expect(result.passed).toBe(false);
    });

    it('should fail if sweep quality is too low', () => {
      defaultContext.liquidityState.sweepQuality = 30;
      const constraint = new LiquidityConstraint();
      const result = constraint.evaluate(defaultContext);
      expect(result.passed).toBe(false);
    });
    
    it('should pass with high confidence if sweep quality > 80', () => {
      const constraint = new LiquidityConstraint();
      const result = constraint.evaluate(defaultContext);
      expect(result.passed).toBe(true);
      expect(result.confidenceImpact).toBe(15);
    });
  });

  describe('ProbabilityCalibrationEngine Expectancy & Laplace Smoothing', () => {
    it('should smooth win rates using Laplace when sample size is small', () => {
      const calibrator = new ProbabilityCalibrationEngine();
      const confidence = calibrator.getCalibratedBaseConfidence(MarketRegime.TRENDING);
      expect(confidence).toBe(50);

      calibrator.recordTradeResult(MarketRegime.TRENDING, true);
      const conf1 = calibrator.getCalibratedBaseConfidence(MarketRegime.TRENDING);
      expect(conf1).toBe(60);
    });

    it('should scale confidence based on expectancy when sample size >= 10', () => {
      const calibrator = new ProbabilityCalibrationEngine();
      for (let i = 0; i < 10; i++) {
        calibrator.recordTradeResult(MarketRegime.TRENDING, true, 2.5);
      }
      const confidence = calibrator.getCalibratedBaseConfidence(MarketRegime.TRENDING);
      expect(confidence).toBe(100);
    });
  });

  describe('ReplayEngine Sandboxed Validation', () => {
    it('should replay event logs and identify deterministic execution parity', () => {
      const eventLog = EventLog.getInstance();
      eventLog.clear();

      eventLog.append({
        type: 'StateTransition',
        correlationId: 'BTCUSDT',
        payload: {
          from: MarketState.NO_TRADE,
          to: MarketState.ACCUMULATION,
          reason: 'Initial setup'
        },
        marketSnapshot: defaultContext
      });

      const replayer = new ReplayEngine();
      const report = replayer.replay('BTCUSDT');
      expect(report.totalEventsProcessed).toBe(1);
      expect(report.divergencesFound).toBe(0);
    });
  });
});
