import { Constraint, ConstraintResult, MarketContext } from '../engine/Types';

export class HTFAlignmentConstraint implements Constraint {
  public id = 'HTFAlignmentConstraint';

  public evaluate(ctx: MarketContext): ConstraintResult {
    const { trendState } = ctx;

    if (!trendState.htfAlignment) {
      return {
        passed: false,
        confidenceImpact: 0,
        reason: 'Current timeframe direction does not align with Higher Time Frame (HTF) trend.'
      };
    }

    return {
      passed: true,
      confidenceImpact: 0,
      reason: 'HTF Alignment confirmed.'
    };
  }
}
