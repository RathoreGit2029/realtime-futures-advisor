import { EventLog } from './EventSourcing';
import { MarketStateMachine } from './StateMachine';
import { ConstraintEngine } from './ConstraintEngine';
import { MarketContext, MarketState } from './Types';

// Import Constraints
import { RegimeConstraint } from '../constraints/RegimeConstraint';
import { VolatilityConstraint } from '../constraints/VolatilityConstraint';
import { LiquidityConstraint } from '../constraints/LiquidityConstraint';
import { HTFAlignmentConstraint } from '../constraints/HTFAlignmentConstraint';

export interface ReplayReport {
  totalEventsProcessed: number;
  divergencesFound: number;
  details: string[];
}

export class ReplayEngine {
  private eventLog = EventLog.getInstance();
  
  /**
   * Replays a sequence of historical events in a sandboxed runtime to verify identical determinism
   */
  public replay(correlationId?: string): ReplayReport {
    const events = this.eventLog.getEvents({ correlationId });
    
    const sandboxStateMachine = new MarketStateMachine();
    const sandboxConstraintEngine = new ConstraintEngine();
    
    // Register identical constraints
    sandboxConstraintEngine.registerConstraint(new RegimeConstraint());
    sandboxConstraintEngine.registerConstraint(new VolatilityConstraint());
    sandboxConstraintEngine.registerConstraint(new LiquidityConstraint());
    sandboxConstraintEngine.registerConstraint(new HTFAlignmentConstraint());
    
    let totalEventsProcessed = 0;
    let divergencesFound = 0;
    const details: string[] = [];

    for (const event of events) {
      totalEventsProcessed++;
      
      if (event.type === 'StateTransition') {
        const { to, reason } = event.payload;
        const mockContext = event.marketSnapshot;
        
        if (mockContext) {
          const success = sandboxStateMachine.transition(to, mockContext, reason);
          const currentSandboxState = sandboxStateMachine.getCurrentState();
          
          if (currentSandboxState !== to) {
            divergencesFound++;
            details.push(
              `State divergence at event ${event.eventId}: Expected state ${to}, but Sandbox resolved to ${currentSandboxState} (Transition Success: ${success})`
            );
          }
        }
      }
      
      if (event.type === 'ConstraintRejected' || event.type === 'ConstraintPassed') {
        const mockContext = event.marketSnapshot;
        if (mockContext) {
          const expectedPass = event.type === 'ConstraintPassed';
          const decision = sandboxConstraintEngine.evaluate(mockContext);
          
          if (decision.tradeEligible !== expectedPass) {
            divergencesFound++;
            details.push(
              `DAG divergence at event ${event.eventId}: Expected pass=${expectedPass}, but Sandbox DAG resolved tradeEligible=${decision.tradeEligible}`
            );
          }
        }
      }
    }

    return {
      totalEventsProcessed,
      divergencesFound,
      details
    };
  }
}
