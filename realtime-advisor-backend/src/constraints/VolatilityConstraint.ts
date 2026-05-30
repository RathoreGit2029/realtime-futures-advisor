import { Constraint, ConstraintResult, MarketContext } from '../engine/Types.js';

export class VolatilityConstraint implements Constraint {
  public id = 'VolatilityConstraint';

  public evaluate(ctx: MarketContext): ConstraintResult {
    const { volatility, spread } = ctx;

    if (volatility.historicalRank > 95) {
      return {
        passed: false,
        confidenceImpact: 0,
        reason: `Volatility rank ${volatility.historicalRank} > 95. Too dangerous to execute.`
      };
    }

    // Spread expansion check during high volatility
    if (volatility.isExpanding && spread > volatility.atr * 0.1) {
      return {
        passed: false,
        confidenceImpact: 0,
        reason: `Spread expansion detected during volatility spike. Spread=${spread}, ATR=${volatility.atr}`
      };
    }

    return {
      passed: true,
      confidenceImpact: 0,
      reason: 'Volatility conditions are within safe execution parameters.'
    };
  }
}
