import { describe, it, expect, beforeEach } from '@jest/globals';
import { createMarketContext, MarketRegime, MarketState } from '../engine/Types';
import { CorrelationEngine, Candle } from '../engine/CorrelationEngine';
import { PortfolioHeatConstraint } from '../constraints/PortfolioHeatConstraint';

describe('Correlation & Portfolio Risk Layer Unit Tests', () => {
  describe('CorrelationEngine', () => {
    it('should calculate returns correctly', () => {
      const candles: Candle[] = [
        { time: 100, open: 10, high: 12, low: 9, close: 10, volume: 100 },
        { time: 200, open: 10, high: 13, low: 10, close: 11, volume: 110 },
        { time: 300, open: 11, high: 11, low: 8, close: 8.8, volume: 120 },
      ];
      
      const returns = CorrelationEngine.calculateReturns(candles);
      expect(returns).toHaveLength(2);
      expect(returns[0]).toBeCloseTo(0.1, 5); // (11 - 10) / 10
      expect(returns[1]).toBeCloseTo(-0.2, 5); // (8.8 - 11) / 11
    });

    it('should calculate Pearson correlation correctly for identical returns', () => {
      const x = [0.01, -0.02, 0.03, -0.01];
      const y = [0.01, -0.02, 0.03, -0.01];
      const corr = CorrelationEngine.calculatePearsonCorrelation(x, y);
      expect(corr).toBeCloseTo(1.0, 5);
    });

    it('should calculate Pearson correlation correctly for opposite returns', () => {
      const x = [0.01, -0.02, 0.03, -0.01];
      const y = [-0.01, 0.02, -0.03, 0.01];
      const corr = CorrelationEngine.calculatePearsonCorrelation(x, y);
      expect(corr).toBeCloseTo(-1.0, 5);
    });

    it('should return 0 when at least one series has zero variance', () => {
      const x = [0.02, 0.02, 0.02, 0.02];
      const y = [0.01, -0.02, 0.03, -0.01];
      const corr = CorrelationEngine.calculatePearsonCorrelation(x, y);
      expect(corr).toBe(0);
    });

    it('should build a correlation matrix correctly', () => {
      const btcCandles: Candle[] = [];
      const ethCandles: Candle[] = [];
      
      // Seed 52 candles so we have 51 closed candles (window size 50 returns 49 values)
      for (let i = 0; i < 52; i++) {
        btcCandles.push({
          time: i * 100,
          open: 100 + i,
          high: 105 + i,
          low: 95 + i,
          close: 100 + (i % 2 === 0 ? i : -i),
          volume: 1000
        });
        ethCandles.push({
          time: i * 100,
          open: 100 + i,
          high: 105 + i,
          low: 95 + i,
          close: 100 + (i % 2 === 0 ? i : -i), // Identical returns
          volume: 1000
        });
      }

      const symbolCandles = {
        BTCUSDT: btcCandles,
        ETHUSDT: ethCandles
      };

      const matrix = CorrelationEngine.calculateCorrelationMatrix(symbolCandles, 50);
      expect(matrix['BTCUSDT']['ETHUSDT']).toBeCloseTo(1.0, 5);
      expect(matrix['ETHUSDT']['BTCUSDT']).toBeCloseTo(1.0, 5);
      expect(matrix['BTCUSDT']['BTCUSDT']).toBe(1.0);
    });
  });

  describe('PortfolioHeatConstraint', () => {
    let baseContext: any;

    beforeEach(() => {
      // Setup matrix with positive correlation between BTC and ETH
      CorrelationEngine.setMatrix({
        BTCUSDT: { BTCUSDT: 1.0, ETHUSDT: 0.8 },
        ETHUSDT: { BTCUSDT: 0.8, ETHUSDT: 1.0 }
      });

      baseContext = {
        timestamp: Date.now(),
        symbol: 'BTCUSDT',
        regime: MarketRegime.TRENDING,
        marketState: MarketState.EXECUTION_WINDOW,
        volatility: { atr: 10, isExpanding: false, isCompressing: false, historicalRank: 50 },
        liquidityState: { hasSweep: true, sweepQuality: 85, recentSweepDirection: 'BULLISH' },
        trendState: { direction: 'UP', strength: 80, htfAlignment: true },
        sessionState: { currentSession: 'NEW_YORK', isOverlap: true, minutesIntoSession: 120 },
        displacementQuality: 90,
        spread: 0.1,
        confidence: 80, // High confidence for larger Kelly size
        currentPrice: 100,
        portfolioWalletBalance: 1000,
        portfolioTrades: [] as any[],
        prospectiveTrade: undefined as any
      };
    });

    it('should pass if portfolio is empty and no prospective trade', () => {
      const constraint = new PortfolioHeatConstraint();
      const context = createMarketContext(baseContext);
      const result = constraint.evaluate(context);
      expect(result.passed).toBe(true);
      expect(result.reason).toContain('Portfolio is empty');
    });

    it('should fail if aggregate margin exceeds 30%', () => {
      const constraint = new PortfolioHeatConstraint();
      
      // 1000 wallet balance. Let's add existing trades with large margin
      const context = createMarketContext({
        ...baseContext,
        portfolioTrades: [
          { symbol: 'ETHUSDT', direction: 'LONG', positionSize: 10, entry: 100, marginRequired: 250, status: 'ACTIVE' },
          { symbol: 'BTCUSDT', direction: 'LONG', positionSize: 5, entry: 100, marginRequired: 100, status: 'ACTIVE' }
        ]
        // 250 + 100 = 350 margin > 300 (30% of 1000) -> fail
      });
      
      const result = constraint.evaluate(context);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('Aggregate margin exceeds limit');
    });

    it('should pass if heat and margin are within bounds', () => {
      const constraint = new PortfolioHeatConstraint();
      
      // Let's add a small trade (weight = 10 * 100 / 1000 = 0.10)
      const context = createMarketContext({
        ...baseContext,
        portfolioTrades: [
          { symbol: 'ETHUSDT', direction: 'LONG', positionSize: 1, entry: 100, marginRequired: 33, status: 'ACTIVE' }
        ]
      });
      
      const result = constraint.evaluate(context);
      expect(result.passed).toBe(true);
      expect(result.metadata.portfolioHeat).toBeCloseTo(0.10, 2);
    });

    it('should fail if correlation-weighted portfolio heat exceeds 15%', () => {
      const constraint = new PortfolioHeatConstraint();
      
      // Add two positively correlated trades
      // w1 = 10 * 100 / 1000 = 1.0
      // w2 = 10 * 100 / 1000 = 1.0
      // rho = 0.8
      // heat = sqrt(w1^2 + w2^2 + 2*w1*w2*rho) = sqrt(1 + 1 + 1.6) = sqrt(3.6) ≈ 1.89 > 0.15 -> fail
      const context = createMarketContext({
        ...baseContext,
        portfolioTrades: [
          { symbol: 'BTCUSDT', direction: 'LONG', positionSize: 1, entry: 100, marginRequired: 33, status: 'ACTIVE' },
          { symbol: 'ETHUSDT', direction: 'LONG', positionSize: 1, entry: 100, marginRequired: 33, status: 'ACTIVE' }
        ]
      });
      
      const result = constraint.evaluate(context);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('portfolio heat exceeds limit');
    });

    it('should respect custom heat and margin limits from context', () => {
      const constraint = new PortfolioHeatConstraint();
      
      const context = createMarketContext({
        ...baseContext,
        maxPortfolioHeat: 0.50, // Increase heat limit to 50%
        maxPortfolioMargin: 0.50, // Increase margin limit to 50%
        portfolioTrades: [
          { symbol: 'BTCUSDT', direction: 'LONG', positionSize: 1, entry: 100, marginRequired: 33, status: 'ACTIVE' },
          { symbol: 'ETHUSDT', direction: 'LONG', positionSize: 1, entry: 100, marginRequired: 33, status: 'ACTIVE' }
        ]
      });
      
      const result = constraint.evaluate(context);
      expect(result.passed).toBe(true); // Should pass now because limit is 50%
      expect(result.metadata.portfolioHeat).toBeLessThan(0.50);
    });

    it('should evaluate prospective trade using fractional Kelly sizing and fail if combined heat is high', () => {
      const constraint = new PortfolioHeatConstraint();
      
      // BTCUSDT prospective LONG entry with stop loss 95 (risk per unit = 5) and target1 110 (R = 2)
      // confidence = 80 -> p = 0.8
      // R = 2
      // rawKelly = 0.25 * (0.8 * 2 - 0.2) / 2 = 0.25 * (1.4) / 2 = 0.175
      // clampedKelly = 0.10 (max limit)
      // riskAmount = 1000 * 0.1 = 100
      // positionSize = 100 / 5 = 20
      // prospective weight = 20 * 100 / 1000 = 2.0
      
      const context = createMarketContext({
        ...baseContext,
        symbol: 'BTCUSDT',
        currentPrice: 100,
        confidence: 80,
        portfolioWalletBalance: 1000,
        portfolioTrades: [
          { symbol: 'ETHUSDT', direction: 'LONG', positionSize: 1, entry: 100, marginRequired: 33, status: 'ACTIVE' }
        ],
        prospectiveTrade: {
          direction: 'LONG',
          stopLoss: 95,
          target1: 110,
          leverage: 20
        }
      });
      
      const result = constraint.evaluate(context);
      // Prospective weight ~ 2.0, existing weight ~ 0.1. Combined heat exceeds 15% easily.
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('portfolio heat exceeds limit');
    });
  });
});
