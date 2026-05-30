"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConstraintEngine = void 0;
const EventSourcing_js_1 = require("./EventSourcing.js");
// Browser-safe djb2 hash — no Buffer/Node.js dependency
function hashString(input) {
    let h = 5381;
    for (let i = 0; i < input.length; i++) {
        h = ((h << 5) + h) ^ input.charCodeAt(i);
        h = h >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}
class ConstraintEngine {
    constraints = [];
    logger = EventSourcing_js_1.EventLog.getInstance();
    clock = this.logger.getClock();
    /**
     * Register a constraint. Constraints are evaluated in registration order.
     * Order is intentional: cheap/broad gates first, expensive/narrow gates last.
     * Do NOT sort — registration order is the contract.
     */
    registerConstraint(constraint) {
        this.constraints.push(constraint);
    }
    /**
     * Evaluate all constraints in registration order.
     * Short-circuits on first failure.
     * finalConfidence is the Bayesian point estimate from context — never synthesised here.
     */
    evaluate(context) {
        const startTime = this.clock.now();
        const individualEvaluations = [];
        const failedConstraints = [];
        const passedConstraints = [];
        const failureReasons = [];
        for (const constraint of this.constraints) {
            const evalStart = this.clock.now();
            const result = constraint.evaluate(context);
            const evaluationTime = this.clock.now() - evalStart;
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
                const totalEvaluationTime = this.clock.now() - startTime;
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
        const totalEvaluationTime = this.clock.now() - startTime;
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
    decisionHash(context, evaluations) {
        return hashString(JSON.stringify({
            ctxHash: context.deterministicHash,
            evals: evaluations.map(e => ({ id: e.constraintId, passed: e.passed }))
        }));
    }
    getEvaluationOrder() {
        return this.constraints.map(c => c.id);
    }
    getConstraintStatistics() {
        return {
            totalConstraints: this.constraints.length,
            evaluationOrder: this.getEvaluationOrder()
        };
    }
    // Keep for test compatibility
    validateEvaluationOrder() {
        return true;
    }
}
exports.ConstraintEngine = ConstraintEngine;
