import { Constraint, MarketContext, ConstraintResult } from './Types';
import { EventLog } from './EventSourcing';

export class ConstraintEngine {
  private constraints: Constraint[] = [];
  private logger = EventLog.getInstance();

  /**
   * Registers a constraint into the DAG.
   * Order matters as it acts as a short-circuit DAG.
   */
  public registerConstraint(constraint: Constraint): void {
    this.constraints.push(constraint);
  }

  /**
   * Evaluates the sequence of constraints.
   * Returns a comprehensive explanation object.
   */
  public evaluate(context: MarketContext): { tradeEligible: boolean; failedConstraints: string[]; passedConstraints: string[]; finalConfidence: number } {
    const failedConstraints: string[] = [];
    const passedConstraints: string[] = [];
    let currentConfidence = context.confidence; // Starting base from calibration

    for (const constraint of this.constraints) {
      const result = constraint.evaluate(context);
      
      if (!result.passed) {
        failedConstraints.push(constraint.id);
        
        this.logger.append({
          type: 'ConstraintRejected',
          correlationId: context.symbol,
          payload: {
            constraintId: constraint.id,
            reason: result.reason
          },
          marketSnapshot: context
        });

        // Short-circuit: Institutional fail-fast architecture
        return {
          tradeEligible: false,
          failedConstraints,
          passedConstraints,
          finalConfidence: 0
        };
      }

      passedConstraints.push(constraint.id);
      currentConfidence += result.confidenceImpact;
      
      this.logger.append({
        type: 'ConstraintPassed',
        correlationId: context.symbol,
        payload: {
          constraintId: constraint.id,
          impact: result.confidenceImpact
        }
      });
    }

    return {
      tradeEligible: true,
      failedConstraints,
      passedConstraints,
      finalConfidence: currentConfidence
    };
  }
}
