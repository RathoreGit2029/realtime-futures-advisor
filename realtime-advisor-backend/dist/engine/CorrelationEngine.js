"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CorrelationEngine = void 0;
class CorrelationEngine {
    static matrix = {};
    static setMatrix(newMatrix) {
        this.matrix = newMatrix;
    }
    static getCorrelation(sym1, sym2) {
        if (sym1 === sym2)
            return 1.0;
        return this.matrix[sym1]?.[sym2] ?? 0.0;
    }
    /**
     * Calculates simple returns for a series of candles.
     * R_t = (Close_t - Close_{t-1}) / Close_{t-1}
     * For N candles, returns N-1 return values.
     */
    static calculateReturns(candles) {
        const returns = [];
        for (let i = 1; i < candles.length; i++) {
            const prevClose = candles[i - 1].close;
            if (prevClose === 0) {
                returns.push(0);
            }
            else {
                returns.push((candles[i].close - prevClose) / prevClose);
            }
        }
        return returns;
    }
    /**
     * Computes Pearson correlation coefficient between two return series.
     * Minimum length for correlation is 2. Defaults to 0 if not enough data or zero variance.
     */
    static calculatePearsonCorrelation(x, y) {
        const len = Math.min(x.length, y.length);
        if (len < 2)
            return 0;
        // Align by taking the last `len` elements of both series
        const xs = x.slice(-len);
        const ys = y.slice(-len);
        const xMean = xs.reduce((a, b) => a + b, 0) / len;
        const yMean = ys.reduce((a, b) => a + b, 0) / len;
        let num = 0;
        let denX = 0;
        let denY = 0;
        for (let i = 0; i < len; i++) {
            const diffX = xs[i] - xMean;
            const diffY = ys[i] - yMean;
            num += diffX * diffY;
            denX += diffX * diffX;
            denY += diffY * diffY;
        }
        if (denX === 0 || denY === 0) {
            return 0;
        }
        return num / Math.sqrt(denX * denY);
    }
    /**
     * Returns a map of symbol-to-symbol correlation values.
     * Represented as a Record<string, Record<string, number>>.
     */
    static calculateCorrelationMatrix(symbolCandles, windowSize = 50) {
        const matrix = {};
        const symbols = Object.keys(symbolCandles);
        const returnSeries = {};
        for (const sym of symbols) {
            const allCandles = symbolCandles[sym] || [];
            // Exclude the last candle if it's currently forming/open, but if we have only closed candles we can use them.
            // In the WS manager tick, sData.candles contains the live candle as the last item.
            // So allCandles.slice(0, -1) gets the fully closed ones.
            const closedCandles = allCandles.slice(0, -1).slice(-windowSize);
            if (closedCandles.length >= 2) {
                returnSeries[sym] = this.calculateReturns(closedCandles);
            }
            else {
                returnSeries[sym] = [];
            }
        }
        // Initialize matrix
        for (const sym1 of symbols) {
            matrix[sym1] = {};
            for (const sym2 of symbols) {
                if (sym1 === sym2) {
                    matrix[sym1][sym2] = 1.0;
                }
                else {
                    matrix[sym1][sym2] = 0.0;
                }
            }
        }
        // Calculate pairwise correlations
        for (let i = 0; i < symbols.length; i++) {
            const sym1 = symbols[i];
            const r1 = returnSeries[sym1];
            if (!r1 || r1.length < 2)
                continue;
            for (let j = i + 1; j < symbols.length; j++) {
                const sym2 = symbols[j];
                const r2 = returnSeries[sym2];
                if (!r2 || r2.length < 2)
                    continue;
                const corr = this.calculatePearsonCorrelation(r1, r2);
                matrix[sym1][sym2] = corr;
                matrix[sym2][sym1] = corr;
            }
        }
        return matrix;
    }
}
exports.CorrelationEngine = CorrelationEngine;
