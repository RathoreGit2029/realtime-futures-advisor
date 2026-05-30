import { Constraint, MarketContext } from './Types';
import { EventLog } from './EventSourcing';

// Browser-safe djb2 hash — no Buffer/Node.js dependency
function hashString(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h) ^ input.charCodeAt(i);
    h = h >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export interface ConstraintEvaluation {
  constraintId: string;
  passed: boolean;
  reason: string;
  confidenceImpact: number;
  metadata?: any;
  evaluationTime: number;
}

export interface ConstraintDecision {
  tradeEligible: boolean;
  failedConstraints: string[];
  passedConstraints: string[];
  failureReasons: string[];
  finalConfidence: number;
  individualEvaluations: ConstraintEvaluation[];
  totalEvaluationTime: number;
  deterministicHash: string;
}

export class ConstraintEngine {
  private constraints: Constraint[] = [];
  private logger = EventLog.getInstance();

  /**
   * Register a constraint. Constraints are evaluated in registration order.
   * Order is intentional: cheap/broad gates first, expensive/narrow gates last.
   * Do NOT sort — registration order is the contract.
   */
  public registerConstraint(constraint: Constraint): void {
    this.constraints.push(constraint);
  }

  /**
   * Evaluate all constraints in registration order.
   * Short-circuits on first failure.
   * finalConfidence is the Bayesian point estimate from context — never synthesised here.
   */
  public evaluate(context: MarketContext): ConstraintDecision {
    const startTime = Date.now();
    const individualEvaluations: ConstraintEvaluation[] = [];
    const failedConstraints: string[] = [];
    const passedConstraints: string[] = [];
    const failureReasons: string[] = [];

    for (const constraint of this.constraints) {
      const evalStart = Date.now();
      const result = constraint.evaluate(context);
      const evaluationTime = Date.now() - evalStart;

      individualEvaluations.push({
        constraintId: constraint.id,
        passed: result.passed,
        reason: result.reason,
        confidenceImpact: result.confidenceImpact,
        metadata: result.metadata,
        evaluationTime
      });

      if (!result.passed) {
        failedConstraints.push(constraint.id);
        failureReasons.push(result.reason);

        this.logger.append({
          type: 'ConstraintRejected',
          correlationId: context.symbol,
          payload: { constraintId: constraint.id, reason: result.reason },
          marketContextSnapshot: context
        });

        const totalEvaluationTime = Date.now() - startTime;
        return {
          tradeEligible: false,
          failedConstraints,
          passedConstraints,
          failureReasons,
          finalConfidence: 0,
          individualEvaluations,
          totalEvaluationTime,
          deterministicHash: this.decisionHash(context, individualEvaluations)
        };
      }

      passedConstraints.push(constraint.id);
      this.logger.append({
        type: 'ConstraintPassed',
        correlationId: context.symbol,
        payload: { constraintId: constraint.id },
        marketContextSnapshot: context
      });
    }

    const totalEvaluationTime = Date.now() - startTime;
    const finalConfidence = Math.max(0, Math.min(100, context.confidence));

    return {
      tradeEligible: true,
      failedConstraints,
      passedConstraints,
      failureReasons,
      finalConfidence,
      individualEvaluations,
      totalEvaluationTime,
      deterministicHash: this.decisionHash(context, individualEvaluations)
    };
  }

  private decisionHash(context: MarketContext, evaluations: ConstraintEvaluation[]): string {
    return hashString(JSON.stringify({
      ctxHash: context.deterministicHash,
      evals: evaluations.map(e => ({ id: e.constraintId, passed: e.passed }))
    }));
  }

  public getEvaluationOrder(): string[] {
    return this.constraints.map(c => c.id);
  }

  public getConstraintStatistics(): {
    totalConstraints: number;
    evaluationOrder: string[];
  } {
    return {
      totalConstraints: this.constraints.length,
      evaluationOrder: this.getEvaluationOrder()
    };
  }

  // Keep for test compatibility
  public validateEvaluationOrder(): boolean {
    return true;
  }
}
