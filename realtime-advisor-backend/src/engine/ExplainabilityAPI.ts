import { EventLog } from './EventSourcing.js';
import { MarketContext, MarketState } from './Types.js';

export class ExplainabilityAPI {
  private eventLog = EventLog.getInstance();

  /**
   * Explains why a trade was rejected or accepted based on recent events.
   */
  public explainRecentDecisions(symbol: string, timeWindowMs = 60000): any {
    const startTime = this.eventLog.getClock().now() - timeWindowMs;
    const recentEvents = this.eventLog.getEvents({ startTs: startTime, correlationId: symbol });

    const rejections = recentEvents.filter(e => e.type === 'ConstraintRejected');
    const stateTransitions = recentEvents.filter(e => e.type === 'StateTransition');
    const executionDecisions = recentEvents.filter(e => e.type === 'ExecutionValidated' || e.type === 'ExecutionRejected');

    // Aggregate failure reasons to show the user exactly why the bot is waiting
    const activeBlockers = new Set(rejections.map(e => e.payload.reason));

    const currentStateEvent = [...stateTransitions].reverse()[0];
    const currentState = currentStateEvent ? currentStateEvent.payload.to : MarketState.NO_TRADE;

    return {
      symbol,
      currentState,
      tradeEligible: rejections.length === 0 && currentState === MarketState.EXECUTION_WINDOW,
      activeBlockers: Array.from(activeBlockers),
      recentTransitions: stateTransitions.map(e => ({
        time: new Date(e.receiveTimestamp).toISOString(),
        from: e.payload.from,
        to: e.payload.to,
        reason: e.payload.reason
      })),
      executionSafety: executionDecisions.length > 0 ? executionDecisions[executionDecisions.length - 1].payload : null
    };
  }
}
