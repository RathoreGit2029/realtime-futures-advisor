"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HTFAlignmentConstraint = void 0;
class HTFAlignmentConstraint {
    id = 'HTFAlignmentConstraint';
    evaluate(ctx) {
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
exports.HTFAlignmentConstraint = HTFAlignmentConstraint;
