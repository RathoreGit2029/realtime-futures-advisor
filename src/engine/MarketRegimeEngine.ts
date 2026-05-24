import { MarketRegime, MarketContext } from './Types';
import { EventLog } from './EventSourcing';

export class MarketRegimeEngine {
  private logger = EventLog.getInstance();

  /**
   * Evaluates the current regime based on context data.
   * In Phase 1, this uses basic heuristic boundaries.
   * Future phases will use the probability engine.
   */
  public classify(context: MarketContext): MarketRegime {
    const { volatility, trendState, sessionState } = context;

    let newRegime = MarketRegime.CHOPPY;

    if (sessionState.isOverlap && volatility.isExpanding && trendState.strength > 70) {
      newRegime = MarketRegime.TRENDING;
    } else if (volatility.isCompressing && trendState.strength < 30) {
      newRegime = MarketRegime.COMPRESSION;
    } else if (volatility.historicalRank > 95) {
      newRegime = MarketRegime.HIGH_VOLATILITY;
    } else if (trendState.direction === 'SIDEWAYS' && volatility.atr > 0) {
      newRegime = MarketRegime.MEAN_REVERTING;
    }

    if (context.regime !== newRegime) {
      this.logger.append({
        type: 'RegimeChanged',
        correlationId: context.symbol,
        payload: {
          from: context.regime,
          to: newRegime,
          reason: `Volatility Rank: ${volatility.historicalRank}, Trend Strength: ${trendState.strength}`
        },
        marketSnapshot: context
      });
    }

    return newRegime;
  }
}
