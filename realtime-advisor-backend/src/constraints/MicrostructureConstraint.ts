import { Constraint, ConstraintResult, MarketContext, MarketState } from '../engine/Types.js';

export class MicrostructureConstraint implements Constraint {
  public id = 'MicrostructureConstraint';

  public evaluate(ctx: MarketContext): ConstraintResult {
    const { spread, orderbookDepth, orderbookImbalance, currentPrice, trendState, marketState } = ctx;

    // Only strictly enforce microstructure constraints during active execution windows
    if (marketState !== MarketState.EXECUTION_WINDOW) {
      return {
        passed: true,
        confidenceImpact: 0,
        reason: 'Microstructure bypass: not in execution window.'
      };
    }

    // 1. Spread tightness check (spread must be < 0.05% of the current price)
    const maxSpread = currentPrice * 0.0005;
    if (spread > maxSpread) {
      return {
        passed: false,
        confidenceImpact: 0,
        reason: `Spread expansion detected: spread is ${spread.toFixed(4)} (> 0.05% of price: ${maxSpread.toFixed(4)}).`
      };
    }

    // 2. Order book depth check
    if (orderbookDepth !== undefined && orderbookDepth <= 0) {
      return {
        passed: false,
        confidenceImpact: 0,
        reason: `Insufficient order book depth: depth is ${orderbookDepth}.`
      };
    }

    // 3. Bid-Ask volume imbalance check (if available)
    if (orderbookImbalance !== undefined) {
      const direction = trendState.direction;
      if (direction === 'UP') {
        // LONG entry requires bids to not be heavily outweighed (imbalance > 0.40)
        if (orderbookImbalance < 0.40) {
          return {
            passed: false,
            confidenceImpact: 0,
            reason: `Order book imbalance opposes LONG: buy volume is only ${(orderbookImbalance * 100).toFixed(1)}% of top book.`
          };
        }
      } else if (direction === 'DOWN') {
        // SHORT entry requires asks to not be heavily outweighed (imbalance < 0.60)
        if (orderbookImbalance > 0.60) {
          return {
            passed: false,
            confidenceImpact: 0,
            reason: `Order book imbalance opposes SHORT: sell volume is only ${((1 - orderbookImbalance) * 100).toFixed(1)}% of top book.`
          };
        }
      }
    }

    return {
      passed: true,
      confidenceImpact: 0,
      reason: 'Microstructure indicators are within safe execution parameters.'
    };
  }
}
