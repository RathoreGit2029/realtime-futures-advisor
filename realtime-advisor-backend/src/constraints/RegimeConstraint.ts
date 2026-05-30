import { Constraint, ConstraintResult, MarketContext, MarketRegime } from '../engine/Types.js';

export class RegimeConstraint implements Constraint {
  public id = 'RegimeConstraint';
  
  private allowedRegimes: MarketRegime[];

  constructor(allowedRegimes: MarketRegime[] = [
    MarketRegime.TRENDING,
    MarketRegime.COMPRESSION,
    MarketRegime.MEAN_REVERTING,
    MarketRegime.CHOPPY
  ]) {
    this.allowedRegimes = allowedRegimes;
  }

  public evaluate(ctx: MarketContext): ConstraintResult {
    const isAllowed = this.allowedRegimes.includes(ctx.regime);

    if (!isAllowed) {
      return {
        passed: false,
        confidenceImpact: 0,
        reason: `Regime ${ctx.regime} is not in allowed list: [${this.allowedRegimes.join(', ')}]`
      };
    }

    return {
      passed: true,
      confidenceImpact: 0,
      reason: `Regime ${ctx.regime} aligns with execution strategy.`
    };
  }
}
