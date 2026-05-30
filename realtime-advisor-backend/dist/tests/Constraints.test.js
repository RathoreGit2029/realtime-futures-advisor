"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const globals_1 = require("@jest/globals");
const RegimeConstraint_js_1 = require("../constraints/RegimeConstraint.js");
const VolatilityConstraint_js_1 = require("../constraints/VolatilityConstraint.js");
const LiquidityConstraint_js_1 = require("../constraints/LiquidityConstraint.js");
const Types_js_1 = require("../engine/Types.js");
const ProbabilityCalibration_js_1 = require("../engine/ProbabilityCalibration.js");
// Mock fetch globally to prevent network tests from hanging
globalThis.fetch = globals_1.jest.fn().mockImplementation(() => Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ success: true }),
}));
(0, globals_1.describe)('Constraint DAG Unit Tests', () => {
    let defaultContext;
    let sequenceNumber = 0;
    (0, globals_1.beforeEach)(() => {
        // Generate a fresh mock context for each test using immutable creation
        defaultContext = (0, Types_js_1.createMarketContext)({
            timestamp: Date.now(),
            symbol: 'BTCUSDT',
            regime: Types_js_1.MarketRegime.TRENDING,
            marketState: Types_js_1.MarketState.EXECUTION_WINDOW,
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
    (0, globals_1.describe)('RegimeConstraint', () => {
        (0, globals_1.it)('should pass in a TRENDING regime with a positive confidence impact', () => {
            const constraint = new RegimeConstraint_js_1.RegimeConstraint();
            const result = constraint.evaluate(defaultContext);
            (0, globals_1.expect)(result.passed).toBe(true);
            (0, globals_1.expect)(result.confidenceImpact).toBe(0);
        });
        (0, globals_1.it)('should fail in an unallowed regime (e.g. LIQUIDATION_CASCADE)', () => {
            const liquidationContext = (0, Types_js_1.createMarketContext)({
                ...defaultContext,
                regime: Types_js_1.MarketRegime.LIQUIDATION_CASCADE,
                sequenceNumber: sequenceNumber++
            });
            const constraint = new RegimeConstraint_js_1.RegimeConstraint();
            const result = constraint.evaluate(liquidationContext);
            (0, globals_1.expect)(result.passed).toBe(false);
            (0, globals_1.expect)(result.reason).toContain('not in allowed list');
        });
    });
    (0, globals_1.describe)('VolatilityConstraint', () => {
        (0, globals_1.it)('should fail if historical rank > 95', () => {
            const highVolContext = (0, Types_js_1.createMarketContext)({
                ...defaultContext,
                volatility: {
                    ...defaultContext.volatility,
                    historicalRank: 98
                },
                sequenceNumber: sequenceNumber++
            });
            const constraint = new VolatilityConstraint_js_1.VolatilityConstraint();
            const result = constraint.evaluate(highVolContext);
            (0, globals_1.expect)(result.passed).toBe(false);
        });
        (0, globals_1.it)('should fail if spread expands dangerously during volatility expansion', () => {
            const expandingVolContext = (0, Types_js_1.createMarketContext)({
                ...defaultContext,
                volatility: {
                    ...defaultContext.volatility,
                    isExpanding: true
                },
                spread: 15, // > 10% of ATR (100)
                sequenceNumber: sequenceNumber++
            });
            const constraint = new VolatilityConstraint_js_1.VolatilityConstraint();
            const result = constraint.evaluate(expandingVolContext);
            (0, globals_1.expect)(result.passed).toBe(false);
            (0, globals_1.expect)(result.reason).toContain('Spread expansion detected');
        });
    });
    (0, globals_1.describe)('LiquidityConstraint', () => {
        (0, globals_1.it)('should fail if no sweep occurred before execution window', () => {
            const noSweepContext = (0, Types_js_1.createMarketContext)({
                ...defaultContext,
                liquidityState: {
                    ...defaultContext.liquidityState,
                    hasSweep: false
                },
                sequenceNumber: sequenceNumber++
            });
            const constraint = new LiquidityConstraint_js_1.LiquidityConstraint();
            const result = constraint.evaluate(noSweepContext);
            (0, globals_1.expect)(result.passed).toBe(false);
        });
        (0, globals_1.it)('should fail if sweep quality is too low', () => {
            const lowQualityContext = (0, Types_js_1.createMarketContext)({
                ...defaultContext,
                liquidityState: {
                    ...defaultContext.liquidityState,
                    sweepQuality: 30
                },
                sequenceNumber: sequenceNumber++
            });
            const constraint = new LiquidityConstraint_js_1.LiquidityConstraint();
            const result = constraint.evaluate(lowQualityContext);
            (0, globals_1.expect)(result.passed).toBe(false);
        });
        (0, globals_1.it)('should pass with high confidence if sweep quality > 80', () => {
            const constraint = new LiquidityConstraint_js_1.LiquidityConstraint();
            const result = constraint.evaluate(defaultContext);
            (0, globals_1.expect)(result.passed).toBe(true);
            (0, globals_1.expect)(result.confidenceImpact).toBe(0);
        });
    });
    (0, globals_1.describe)('ProbabilityCalibrationEngine Bayesian Inference', () => {
        (0, globals_1.it)('should provide Bayesian probability estimates with credible intervals', () => {
            const calibrator = new ProbabilityCalibration_js_1.ProbabilityCalibrationEngine();
            const estimate = calibrator.getCalibratedBaseConfidence(Types_js_1.MarketRegime.TRENDING);
            (0, globals_1.expect)(estimate.pointEstimate).toBeGreaterThanOrEqual(0);
            (0, globals_1.expect)(estimate.pointEstimate).toBeLessThanOrEqual(100);
            (0, globals_1.expect)(estimate.credibleInterval95).toHaveLength(2);
            (0, globals_1.expect)(estimate.credibleInterval95[0]).toBeLessThan(estimate.credibleInterval95[1]);
            (0, globals_1.expect)(estimate.isReliable).toBe(false); // Initially not enough data
        });
        (0, globals_1.it)('should update Bayesian statistics with trade results', () => {
            const calibrator = new ProbabilityCalibration_js_1.ProbabilityCalibrationEngine();
            // Record some trades
            calibrator.recordTradeResult(Types_js_1.MarketRegime.TRENDING, true, 2.5);
            calibrator.recordTradeResult(Types_js_1.MarketRegime.TRENDING, false, 1.0);
            calibrator.recordTradeResult(Types_js_1.MarketRegime.TRENDING, true, 3.0);
            const estimate = calibrator.getCalibratedBaseConfidence(Types_js_1.MarketRegime.TRENDING);
            (0, globals_1.expect)(estimate.effectiveSampleSize).toBe(3);
            (0, globals_1.expect)(estimate.standardError).toBeGreaterThan(0);
        });
        (0, globals_1.it)('should become more reliable with more data', () => {
            const calibrator = new ProbabilityCalibration_js_1.ProbabilityCalibrationEngine();
            // Record many trades
            for (let i = 0; i < 30; i++) {
                calibrator.recordTradeResult(Types_js_1.MarketRegime.TRENDING, Math.random() > 0.5, 2.0);
            }
            const estimate = calibrator.getCalibratedBaseConfidence(Types_js_1.MarketRegime.TRENDING);
            const stats = calibrator.getRegimeStatistics(Types_js_1.MarketRegime.TRENDING);
            (0, globals_1.expect)(estimate.effectiveSampleSize).toBe(30);
            (0, globals_1.expect)(stats.totalTrades).toBe(30);
            (0, globals_1.expect)(stats.alpha + stats.beta).toBeGreaterThan(30); // Includes prior
        });
        (0, globals_1.it)('should hydrate with historical regime-specific priors on cold start', () => {
            const calibrator = new ProbabilityCalibration_js_1.ProbabilityCalibrationEngine();
            const trendingEstimate = calibrator.getCalibratedBaseConfidence(Types_js_1.MarketRegime.TRENDING);
            // TRENDING prior: alpha = 15, beta = 7 -> mean = 15/22 ≈ 68.2%
            (0, globals_1.expect)(trendingEstimate.pointEstimate).toBeCloseTo(68.18, 1);
            const choppyEstimate = calibrator.getCalibratedBaseConfidence(Types_js_1.MarketRegime.CHOPPY);
            // CHOPPY prior: alpha = 4, beta = 11 -> mean = 4/15 ≈ 26.7%
            (0, globals_1.expect)(choppyEstimate.pointEstimate).toBeCloseTo(26.67, 1);
        });
    });
    (0, globals_1.describe)('ExecutionSafetyLayer', () => {
        (0, globals_1.it)('should pass validation and calculate correct slippage for a LONG position', () => {
            const { ExecutionSafetyLayer } = require('../execution/SafetyLayer');
            const safetyLayer = new ExecutionSafetyLayer();
            const context = (0, Types_js_1.createMarketContext)({
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
            (0, globals_1.expect)(result.safe).toBe(true);
            // adjustedEntryPrice = currentPrice (100) + 1.5 * spread (2) = 103
            (0, globals_1.expect)(result.adjustedEntryPrice).toBe(103);
            (0, globals_1.expect)(result.slippagePenalized).toBe(3);
        });
        (0, globals_1.it)('should pass validation and calculate correct slippage for a SHORT position', () => {
            const { ExecutionSafetyLayer } = require('../execution/SafetyLayer');
            const safetyLayer = new ExecutionSafetyLayer();
            const context = (0, Types_js_1.createMarketContext)({
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
            (0, globals_1.expect)(result.safe).toBe(true);
            // adjustedEntryPrice = currentPrice (100) - 1.5 * spread (2) = 97
            (0, globals_1.expect)(result.adjustedEntryPrice).toBe(97);
            (0, globals_1.expect)(result.slippagePenalized).toBe(3);
        });
        (0, globals_1.it)('should reject execution if price has drifted more than 5% of ATR (Stale Tick Gate)', () => {
            const { ExecutionSafetyLayer } = require('../execution/SafetyLayer');
            const safetyLayer = new ExecutionSafetyLayer();
            const context = (0, Types_js_1.createMarketContext)({
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
            (0, globals_1.expect)(result.safe).toBe(false);
            (0, globals_1.expect)(result.reason).toContain('Stale Tick Gate');
        });
    });
});
