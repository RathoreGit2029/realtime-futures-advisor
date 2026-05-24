import { Constraint, ConstraintResult, MarketContext, MarketRegime } from '../engine/Types';

export class RegimeConstraint implements Constraint {
  public id = 'RegimeConstraint';
  
  private allowedRegimes: MarketRegime[];

  constructor(allowedRegimes: MarketRegime[] = [MarketRegime.TRENDING, MarketRegime.COMPRESSION, MarketRegime.MEAN_REVERTING]) {
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

    // Dynamic confidence based on regime compatibility
    let impact = 0;
    if (ctx.regime === MarketRegime.TRENDING) impact = 15;
    if (ctx.regime === MarketRegime.MEAN_REVERTING) impact = 5;

    return {
      passed: true,
      confidenceImpact: impact,
      reason: `Regime ${ctx.regime} aligns with execution strategy.`
    };
  }
}
