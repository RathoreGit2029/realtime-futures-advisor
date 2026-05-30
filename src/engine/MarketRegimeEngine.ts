import { MarketRegime, MarketContext, RawMarketInput } from './Types';
import { EventLog } from './EventSourcing';

// Minimal shape needed for regime classification
type RegimeInputs = Pick<RawMarketInput, 'symbol' | 'regime' | 'volatility' | 'trendState' | 'sessionState'>;

export class MarketRegimeEngine {
  private logger = EventLog.getInstance();

  /**
   * Classify regime from a full MarketContext.
   * Used internally after context is built.
   */
  public classify(context: MarketContext): MarketRegime {
    return this.classifyRaw(context);
  }

  /**
   * Classify regime from a partial context object.
   * Called by AntigravityEngine before the full immutable context is assembled,
   * and directly from background.js via the engine bundle.
   *
   * Rules are evaluated in priority order — first match wins.
   */
  public classifyRaw(inputs: RegimeInputs): MarketRegime {
    const { volatility, trendState, sessionState } = inputs;

    const isTradeSession =
      sessionState.currentSession === 'LONDON' ||
      sessionState.currentSession === 'NEW_YORK' ||
      sessionState.currentSession === 'ASIA';

    let newRegime: MarketRegime;

    if (volatility.historicalRank > 95) {
      // Extreme volatility overrides everything — do not trade
      newRegime = MarketRegime.HIGH_VOLATILITY;
    } else if (isTradeSession && volatility.isExpanding && trendState.strength > 60) {
      newRegime = MarketRegime.TRENDING;
    } else if (volatility.isCompressing && trendState.strength < 30) {
      newRegime = MarketRegime.COMPRESSION;
    } else if (trendState.direction === 'SIDEWAYS' && volatility.atr > 0) {
      newRegime = MarketRegime.MEAN_REVERTING;
    } else {
      newRegime = MarketRegime.CHOPPY;
    }

    // Log regime transitions
    const previousRegime = inputs.regime;
    if (previousRegime !== undefined && previousRegime !== newRegime) {
      this.logger.append({
        type: 'RegimeChanged',
        correlationId: inputs.symbol,
        payload: {
          from: previousRegime,
          to: newRegime,
          volatilityRank: volatility.historicalRank,
          trendStrength: trendState.strength,
          session: sessionState.currentSession
        }
      });
    }

    return newRegime;
  }

  /**
   * Returns the classification with a full explanation of which rule fired.
   */
  public explainClassification(inputs: RegimeInputs): {
    regime: MarketRegime;
    ruleFired: string;
    inputs: Record<string, number | boolean | string>;
  } {
    const { volatility, trendState, sessionState } = inputs;
    const isTradeSession =
      sessionState.currentSession === 'LONDON' ||
      sessionState.currentSession === 'NEW_YORK' ||
      sessionState.currentSession === 'ASIA';

    let regime: MarketRegime;
    let ruleFired: string;

    if (volatility.historicalRank > 95) {
      regime = MarketRegime.HIGH_VOLATILITY;
      ruleFired = 'volatilityRank > 95';
    } else if (isTradeSession && volatility.isExpanding && trendState.strength > 60) {
      regime = MarketRegime.TRENDING;
      ruleFired = 'tradeSession && isExpanding && strength > 60';
    } else if (volatility.isCompressing && trendState.strength < 30) {
      regime = MarketRegime.COMPRESSION;
      ruleFired = 'isCompressing && strength < 30';
    } else if (trendState.direction === 'SIDEWAYS' && volatility.atr > 0) {
      regime = MarketRegime.MEAN_REVERTING;
      ruleFired = 'direction === SIDEWAYS && atr > 0';
    } else {
      regime = MarketRegime.CHOPPY;
      ruleFired = 'default';
    }

    return {
      regime,
      ruleFired,
      inputs: {
        volatilityRank: volatility.historicalRank,
        isExpanding: volatility.isExpanding,
        isCompressing: volatility.isCompressing,
        trendStrength: trendState.strength,
        trendDirection: trendState.direction,
        isTradeSession
      }
    };
  }
}
