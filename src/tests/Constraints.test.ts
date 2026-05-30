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

    it('should hydrate with historical regime-specific priors on cold start', () => {
      const calibrator = new ProbabilityCalibrationEngine();
      
      const trendingEstimate = calibrator.getCalibratedBaseConfidence(MarketRegime.TRENDING);
      // TRENDING prior: alpha = 15, beta = 7 -> mean = 15/22 ≈ 68.2%
      expect(trendingEstimate.pointEstimate).toBeCloseTo(68.18, 1);

      const choppyEstimate = calibrator.getCalibratedBaseConfidence(MarketRegime.CHOPPY);
      // CHOPPY prior: alpha = 4, beta = 11 -> mean = 4/15 ≈ 26.7%
      expect(choppyEstimate.pointEstimate).toBeCloseTo(26.67, 1);
    });
  });

  describe('ExecutionSafetyLayer', () => {
    it('should pass validation and calculate correct slippage for a LONG position', () => {
      const { ExecutionSafetyLayer } = require('../execution/SafetyLayer');
      const safetyLayer = new ExecutionSafetyLayer();
      
      const context = createMarketContext({
        ...defaultContext,
        currentPrice: 100,
        spread: 2,
        volatility: {
          atr: 10,
          isExpanding: false,
          isCompressing: false,
          historicalRank: 50
        }
      });

      const result = safetyLayer.validateExecution(context, 'LONG', 100);
      expect(result.safe).toBe(true);
      // adjustedEntryPrice = currentPrice (100) + 1.5 * spread (2) = 103
      expect(result.adjustedEntryPrice).toBe(103);
      expect(result.slippagePenalized).toBe(3);
    });

    it('should pass validation and calculate correct slippage for a SHORT position', () => {
      const { ExecutionSafetyLayer } = require('../execution/SafetyLayer');
      const safetyLayer = new ExecutionSafetyLayer();

      const context = createMarketContext({
        ...defaultContext,
        currentPrice: 100,
        spread: 2,
        volatility: {
          atr: 10,
          isExpanding: false,
          isCompressing: false,
          historicalRank: 50
        }
      });

      const result = safetyLayer.validateExecution(context, 'SHORT', 100);
      expect(result.safe).toBe(true);
      // adjustedEntryPrice = currentPrice (100) - 1.5 * spread (2) = 97
      expect(result.adjustedEntryPrice).toBe(97);
      expect(result.slippagePenalized).toBe(3);
    });

    it('should reject execution if price has drifted more than 5% of ATR (Stale Tick Gate)', () => {
      const { ExecutionSafetyLayer } = require('../execution/SafetyLayer');
      const safetyLayer = new ExecutionSafetyLayer();

      const context = createMarketContext({
        ...defaultContext,
        currentPrice: 105.1, // Intended entry is 100. ATR is 100. 5% of ATR is 5. Deviation is 5.1 > 5 -> reject.
        volatility: {
          atr: 100,
          isExpanding: false,
          isCompressing: false,
          historicalRank: 50
        }
      });

      const result = safetyLayer.validateExecution(context, 'LONG', 100);
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('Stale Tick Gate');
    });
  });
});
