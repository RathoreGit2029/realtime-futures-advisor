import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { RegimeConstraint } from '../constraints/RegimeConstraint';
import { VolatilityConstraint } from '../constraints/VolatilityConstraint';
import { LiquidityConstraint } from '../constraints/LiquidityConstraint';
import { MarketContext, MarketRegime, MarketState, createMarketContext } from '../engine/Types';
import { ProbabilityCalibrationEngine } from '../engine/ProbabilityCalibration';

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
  let sequenceNumber = 0;

  beforeEach(() => {
    // Generate a fresh mock context for each test using immutable creation
    defaultContext = createMarketContext({
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
        recentSweepDirection: 'BULLISH'
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
      currentPrice: 65000,
      sequenceNumber: sequenceNumber++
    });
  });

  describe('RegimeConstraint', () => {
    it('should pass in a TRENDING regime with a positive confidence impact', () => {
      const constraint = new RegimeConstraint();
      const result = constraint.evaluate(defaultContext);
      expect(result.passed).toBe(true);
      expect(result.confidenceImpact).toBe(0);
    });

    it('should fail in an unallowed regime (e.g. LIQUIDATION_CASCADE)', () => {
      const liquidationContext = createMarketContext({
        ...defaultContext,
        regime: MarketRegime.LIQUIDATION_CASCADE,
        sequenceNumber: sequenceNumber++
      });
      const constraint = new RegimeConstraint();
      const result = constraint.evaluate(liquidationContext);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('not in allowed list');
    });
  });

  describe('VolatilityConstraint', () => {
    it('should fail if historical rank > 95', () => {
      const highVolContext = createMarketContext({
        ...defaultContext,
        volatility: {
          ...defaultContext.volatility,
          historicalRank: 98
        },
        sequenceNumber: sequenceNumber++
      });
      const constraint = new VolatilityConstraint();
      const result = constraint.evaluate(highVolContext);
      expect(result.passed).toBe(false);
    });

    it('should fail if spread expands dangerously during volatility expansion', () => {
      const expandingVolContext = createMarketContext({
        ...defaultContext,
        volatility: {
          ...defaultContext.volatility,
          isExpanding: true
        },
        spread: 15, // > 10% of ATR (100)
        sequenceNumber: sequenceNumber++
      });
      const constraint = new VolatilityConstraint();
      const result = constraint.evaluate(expandingVolContext);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('Spread expansion detected');
    });
  });

  describe('LiquidityConstraint', () => {
    it('should fail if no sweep occurred before execution window', () => {
      const noSweepContext = createMarketContext({
        ...defaultContext,
        liquidityState: {
          ...defaultContext.liquidityState,
          hasSweep: false
        },
        sequenceNumber: sequenceNumber++
      });
      const constraint = new LiquidityConstraint();
      const result = constraint.evaluate(noSweepContext);
      expect(result.passed).toBe(false);
    });

    it('should fail if sweep quality is too low', () => {
      const lowQualityContext = createMarketContext({
        ...defaultContext,
        liquidityState: {
          ...defaultContext.liquidityState,
          sweepQuality: 30
        },
        sequenceNumber: sequenceNumber++
      });
      const constraint = new LiquidityConstraint();
      const result = constraint.evaluate(lowQualityContext);
      expect(result.passed).toBe(false);
    });
    
    it('should pass with high confidence if sweep quality > 80', () => {
      const constraint = new LiquidityConstraint();
      const result = constraint.evaluate(defaultContext);
      expect(result.passed).toBe(true);
      expect(result.confidenceImpact).toBe(0);
    });
  });

  describe('ProbabilityCalibrationEngine Bayesian Inference', () => {
    it('should provide Bayesian probability estimates with credible intervals', () => {
      const calibrator = new ProbabilityCalibrationEngine();
      const estimate = calibrator.getCalibratedBaseConfidence(MarketRegime.TRENDING);
      
      expect(estimate.pointEstimate).toBeGreaterThanOrEqual(0);
      expect(estimate.pointEstimate).toBeLessThanOrEqual(100);
      expect(estimate.credibleInterval95).toHaveLength(2);
      expect(estimate.credibleInterval95[0]).toBeLessThan(estimate.credibleInterval95[1]);
      expect(estimate.isReliable).toBe(false); // Initially not enough data
    });

    it('should update Bayesian statistics with trade results', () => {
      const calibrator = new ProbabilityCalibrationEngine();
      
      // Record some trades
      calibrator.recordTradeResult(MarketRegime.TRENDING, true, 2.5);
      calibrator.recordTradeResult(MarketRegime.TRENDING, false, 1.0);
      calibrator.recordTradeResult(MarketRegime.TRENDING, true, 3.0);
      
      const estimate = calibrator.getCalibratedBaseConfidence(MarketRegime.TRENDING);
      
      expect(estimate.effectiveSampleSize).toBe(3);
      expect(estimate.standardError).toBeGreaterThan(0);
    });

    it('should become more reliable with more data', () => {
      const calibrator = new ProbabilityCalibrationEngine();
      
      // Record many trades
      for (let i = 0; i < 30; i++) {
        calibrator.recordTradeResult(MarketRegime.TRENDING, Math.random() > 0.5, 2.0);
      }
      
      const estimate = calibrator.getCalibratedBaseConfidence(MarketRegime.TRENDING);
      const stats = calibrator.getRegimeStatistics(MarketRegime.TRENDING);
      
      expect(estimate.effectiveSampleSize).toBe(30);
      expect(stats.totalTrades).toBe(30);
      expect(stats.alpha + stats.beta).toBeGreaterThan(30); // Includes prior
    });
  });

});
