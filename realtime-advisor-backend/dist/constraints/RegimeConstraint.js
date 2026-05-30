"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RegimeConstraint = void 0;
const Types_js_1 = require("../engine/Types.js");
class RegimeConstraint {
    id = 'RegimeConstraint';
    allowedRegimes;
    constructor(allowedRegimes = [
        Types_js_1.MarketRegime.TRENDING,
        Types_js_1.MarketRegime.COMPRESSION,
        Types_js_1.MarketRegime.MEAN_REVERTING,
        Types_js_1.MarketRegime.CHOPPY
    ]) {
        this.allowedRegimes = allowedRegimes;
    }
    evaluate(ctx) {
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
exports.RegimeConstraint = RegimeConstraint;
