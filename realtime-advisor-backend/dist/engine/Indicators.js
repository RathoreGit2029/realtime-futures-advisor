"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.calculateEMA = calculateEMA;
exports.calculateRSI = calculateRSI;
exports.calculateMACD = calculateMACD;
exports.calculateATR = calculateATR;
exports.detectLiquiditySweep = detectLiquiditySweep;
exports.detectOrderBlocks = detectOrderBlocks;
exports.detectFVG = detectFVG;
exports.getSwingFractals = getSwingFractals;
exports.updateLiquidityPools = updateLiquidityPools;
exports.detectLiquiditySweeps = detectLiquiditySweeps;
exports.detectMarketStructureShift = detectMarketStructureShift;
exports.calculateDisplacement = calculateDisplacement;
exports.updateFVGRegistry = updateFVGRegistry;
exports.calculateDealingRange = calculateDealingRange;
function calculateEMA(data, period) {
    const k = 2 / (period + 1);
    const ema = [data[0]];
    for (let i = 1; i < data.length; i++) {
        ema.push(data[i] * k + ema[i - 1] * (1 - k));
    }
    return ema;
}
function calculateRSI(closes, period = 14) {
    const rsi = [];
    if (closes.length <= period)
        return rsi;
    let gains = 0;
    let losses = 0;
    for (let i = 1; i <= period; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff > 0)
            gains += diff;
        else
            losses -= diff;
    }
    let avgGain = gains / period;
    let avgLoss = losses / period;
    rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    for (let i = period + 1; i < closes.length; i++) {
        const diff = closes[i] - closes[i - 1];
        let gain = diff > 0 ? diff : 0;
        let loss = diff < 0 ? -diff : 0;
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
        rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
    return rsi;
}
function calculateMACD(closes) {
    const ema12 = calculateEMA(closes, 12);
    const ema26 = calculateEMA(closes, 26);
    const macd = [];
    for (let i = 0; i < closes.length; i++) {
        macd.push(ema12[i] - ema26[i]);
    }
    const signal = calculateEMA(macd.slice(26), 9);
    const paddedSignal = new Array(26).fill(0).concat(signal);
    return { macd, signal: paddedSignal };
}
function calculateATR(candles, period = 14) {
    const len = candles.length;
    const atr = new Array(len).fill(0);
    if (len === 0)
        return atr;
    const tr = new Array(len).fill(0);
    tr[0] = candles[0].high - candles[0].low;
    for (let i = 1; i < len; i++) {
        const h = candles[i].high;
        const l = candles[i].low;
        const pc = candles[i - 1].close;
        tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    }
    let sum = 0;
    const limit = Math.min(len, period);
    for (let i = 0; i < limit; i++)
        sum += tr[i];
    const initialAtr = sum / limit;
    for (let i = 0; i < limit; i++)
        atr[i] = initialAtr;
    for (let i = period; i < len; i++) {
        atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
    }
    return atr;
}
function detectLiquiditySweep(candles, lookbackPeriod = 30, wickRatio = 0.5) {
    const len = candles.length;
    if (len < lookbackPeriod)
        return { bullishSweep: false, bearishSweep: false, level: 0 };
    const current = candles[len - 1];
    const lookback = candles.slice(len - 1 - lookbackPeriod, len - 1);
    const highestHigh = Math.max(...lookback.map(c => c.high));
    const lowestLow = Math.min(...lookback.map(c => c.low));
    const currentRange = current.high - current.low;
    if (currentRange <= 0)
        return { bullishSweep: false, bearishSweep: false, level: 0 };
    const isBullishSweep = current.low < lowestLow && current.close > lowestLow && (current.close - current.low) / currentRange >= wickRatio;
    const isBearishSweep = current.high > highestHigh && current.close < highestHigh && (current.high - current.close) / currentRange >= wickRatio;
    if (isBullishSweep)
        return { bullishSweep: true, bearishSweep: false, level: lowestLow };
    if (isBearishSweep)
        return { bullishSweep: false, bearishSweep: true, level: highestHigh };
    return { bullishSweep: false, bearishSweep: false, level: 0 };
}
function detectOrderBlocks(candles) {
    const bullish = [];
    const bearish = [];
    const len = candles.length;
    for (let i = 5; i < len - 2; i++) {
        const c = candles[i];
        const cNext = candles[i + 1];
        const cNext2 = candles[i + 2];
        const isDown = c.close < c.open;
        const isStrongUp = cNext.close > cNext.open && cNext2.close > cNext2.open && cNext2.close > candles[i - 1].high;
        if (isDown && isStrongUp)
            bullish.push({ index: i, low: c.low, high: c.high, unmitigated: true });
        const isUp = c.close > c.open;
        const isStrongDown = cNext.close < cNext.open && cNext2.close < cNext2.open && cNext2.close < candles[i - 1].low;
        if (isUp && isStrongDown)
            bearish.push({ index: i, low: c.low, high: c.high, unmitigated: true });
    }
    bullish.forEach(ob => {
        for (let j = ob.index + 2; j < len; j++) {
            if (candles[j].low < ob.low) {
                ob.unmitigated = false;
                break;
            }
        }
    });
    bearish.forEach(ob => {
        for (let j = ob.index + 2; j < len; j++) {
            if (candles[j].high > ob.high) {
                ob.unmitigated = false;
                break;
            }
        }
    });
    return { bullish, bearish };
}
function detectFVG(candles) {
    const len = candles.length;
    if (len < 5)
        return { bullishGap: null, bearishGap: null };
    const c1 = candles[len - 4];
    const c2 = candles[len - 3];
    const c3 = candles[len - 2];
    let bullishGap = null;
    let bearishGap = null;
    if (c3.low > c1.high && c2.close > c2.open)
        bullishGap = { low: c1.high, high: c3.low };
    if (c3.high < c1.low && c2.close < c2.open)
        bearishGap = { low: c3.high, high: c1.low };
    return { bullishGap, bearishGap };
}
function getSwingFractals(candles) {
    const swingHighs = [];
    const swingLows = [];
    for (let i = 1; i < candles.length - 1; i++) {
        const prev = candles[i - 1];
        const curr = candles[i];
        const next = candles[i + 1];
        if (curr.high > prev.high && curr.high > next.high) {
            swingHighs.push({ time: curr.time, price: curr.high });
        }
        if (curr.low < prev.low && curr.low < next.low) {
            swingLows.push({ time: curr.time, price: curr.low });
        }
    }
    return { swingHighs, swingLows };
}
function updateLiquidityPools(candles, dailyCandles, existingPools) {
    if (candles.length < 30)
        return [];
    const newPools = [];
    // 1. Major Liquidity
    if (dailyCandles && dailyCandles.length >= 2) {
        const prevDay = dailyCandles[dailyCandles.length - 2];
        newPools.push({
            id: "PDH-" + prevDay.time,
            type: "PDH",
            price: prevDay.high,
            levelType: "BSL",
            strength: 4,
            status: "ACTIVE"
        });
        newPools.push({
            id: "PDL-" + prevDay.time,
            type: "PDL",
            price: prevDay.low,
            levelType: "SSL",
            strength: 4,
            status: "ACTIVE"
        });
        if (dailyCandles.length >= 8) {
            const weeklyCandles = dailyCandles.slice(dailyCandles.length - 8, dailyCandles.length - 1);
            const wh = Math.max(...weeklyCandles.map(c => c.high));
            const wl = Math.min(...weeklyCandles.map(c => c.low));
            const referenceDay = dailyCandles[dailyCandles.length - 2];
            newPools.push({
                id: "WH-" + referenceDay.time,
                type: "WH",
                price: wh,
                levelType: "BSL",
                strength: 5,
                status: "ACTIVE"
            });
            newPools.push({
                id: "WL-" + referenceDay.time,
                type: "WL",
                price: wl,
                levelType: "SSL",
                strength: 5,
                status: "ACTIVE"
            });
        }
    }
    // 2. Session Liquidity (Asian, London)
    let asianHigh = -Infinity, asianLow = Infinity, hasAsian = false;
    let londonHigh = -Infinity, londonLow = Infinity, hasLondon = false;
    candles.forEach(c => {
        const date = new Date(c.time);
        const hour = date.getUTCHours();
        if (hour >= 0 && hour < 9) {
            if (c.high > asianHigh)
                asianHigh = c.high;
            if (c.low < asianLow)
                asianLow = c.low;
            hasAsian = true;
        }
        if (hour >= 8 && hour < 17) {
            if (c.high > londonHigh)
                londonHigh = c.high;
            if (c.low < londonLow)
                londonLow = c.low;
            hasLondon = true;
        }
    });
    if (hasAsian && asianHigh !== -Infinity) {
        newPools.push({ id: "ASIAN_HIGH", type: "ASIAN_HIGH", price: asianHigh, levelType: "BSL", strength: 3, status: "ACTIVE" });
        newPools.push({ id: "ASIAN_LOW", type: "ASIAN_LOW", price: asianLow, levelType: "SSL", strength: 3, status: "ACTIVE" });
    }
    if (hasLondon && londonHigh !== -Infinity) {
        newPools.push({ id: "LONDON_HIGH", type: "LONDON_HIGH", price: londonHigh, levelType: "BSL", strength: 3, status: "ACTIVE" });
        newPools.push({ id: "LONDON_LOW", type: "LONDON_LOW", price: londonLow, levelType: "SSL", strength: 3, status: "ACTIVE" });
    }
    // 3. Intraday swing fractals (3-candle fractal check)
    const fractals = getSwingFractals(candles);
    fractals.swingHighs.forEach(sh => {
        newPools.push({
            id: "SWING_HIGH-" + sh.time,
            type: "SWING_HIGH",
            price: sh.price,
            levelType: "BSL",
            strength: 1,
            status: "ACTIVE"
        });
    });
    fractals.swingLows.forEach(sl => {
        newPools.push({
            id: "SWING_LOW-" + sl.time,
            type: "SWING_LOW",
            price: sl.price,
            levelType: "SSL",
            strength: 1,
            status: "ACTIVE"
        });
    });
    // 4. Equal Highs / Lows (EQH / EQL)
    const eqThreshold = 0.0005; // 0.05%
    for (let i = 0; i < fractals.swingHighs.length; i++) {
        for (let j = i + 1; j < fractals.swingHighs.length; j++) {
            const p1 = fractals.swingHighs[i].price;
            const p2 = fractals.swingHighs[j].price;
            if (Math.abs(p1 - p2) / p1 <= eqThreshold) {
                newPools.push({
                    id: `EQH-${fractals.swingHighs[i].time}-${fractals.swingHighs[j].time}`,
                    type: "EQH",
                    price: (p1 + p2) / 2,
                    levelType: "BSL",
                    strength: 3,
                    status: "ACTIVE"
                });
            }
        }
    }
    for (let i = 0; i < fractals.swingLows.length; i++) {
        for (let j = i + 1; j < fractals.swingLows.length; j++) {
            const p1 = fractals.swingLows[i].price;
            const p2 = fractals.swingLows[j].price;
            if (Math.abs(p1 - p2) / p1 <= eqThreshold) {
                newPools.push({
                    id: `EQL-${fractals.swingLows[i].time}-${fractals.swingLows[j].time}`,
                    type: "EQL",
                    price: (p1 + p2) / 2,
                    levelType: "SSL",
                    strength: 3,
                    status: "ACTIVE"
                });
            }
        }
    }
    newPools.forEach(newP => {
        const match = existingPools.find(existing => existing.id === newP.id);
        if (match) {
            newP.status = match.status;
            newP.sweptAtPrice = match.sweptAtPrice;
            newP.sweptAtTime = match.sweptAtTime;
        }
    });
    return newPools;
}
function detectLiquiditySweeps(candles, pools, currentTickPrice) {
    const len = candles.length;
    if (len < 2 || pools.length === 0)
        return null;
    const current = candles[len - 1];
    let bestSweep = null;
    pools.forEach(pool => {
        if (pool.status !== "ACTIVE")
            return;
        if (pool.levelType === "SSL") {
            if (current.low < pool.price && current.close > pool.price) {
                if (!bestSweep || pool.strength > bestSweep.pool.strength) {
                    bestSweep = {
                        direction: "LONG",
                        pool: pool,
                        sweepPrice: current.low,
                        time: current.time,
                        candleIndex: len - 1
                    };
                }
            }
        }
        else if (pool.levelType === "BSL") {
            if (current.high > pool.price && current.close < pool.price) {
                if (!bestSweep || pool.strength > bestSweep.pool.strength) {
                    bestSweep = {
                        direction: "SHORT",
                        pool: pool,
                        sweepPrice: current.high,
                        time: current.time,
                        candleIndex: len - 1
                    };
                }
            }
        }
    });
    if (bestSweep) {
        const targetPool = pools.find(p => p.id === bestSweep.pool.id);
        if (targetPool) {
            targetPool.status = "SWEPT";
            targetPool.sweptAtPrice = currentTickPrice;
            targetPool.sweptAtTime = Date.now();
        }
    }
    return bestSweep;
}
function detectMarketStructureShift(candles, sweep) {
    const len = candles.length;
    const sweepIndex = sweep.candleIndex;
    let mssTriggerPrice = 0;
    let lookbackStart = Math.max(0, sweepIndex - 15);
    if (sweep.direction === "LONG") {
        let highestHigh = -Infinity;
        for (let i = sweepIndex; i >= lookbackStart; i--) {
            const c = candles[i];
            if (i > 0 && i < len - 1) {
                if (c.high > candles[i - 1].high && c.high > candles[i + 1].high) {
                    if (c.high > highestHigh)
                        highestHigh = c.high;
                }
            }
        }
        if (highestHigh === -Infinity) {
            const recentHighs = candles.slice(Math.max(0, sweepIndex - 5), sweepIndex).map(c => c.high);
            highestHigh = Math.max(...recentHighs, candles[sweepIndex].high);
        }
        mssTriggerPrice = highestHigh;
    }
    else {
        let lowestLow = Infinity;
        for (let i = sweepIndex; i >= lookbackStart; i--) {
            const c = candles[i];
            if (i > 0 && i < len - 1) {
                if (c.low < candles[i - 1].low && c.low < candles[i + 1].low) {
                    if (c.low < lowestLow)
                        lowestLow = c.low;
                }
            }
        }
        if (lowestLow === Infinity) {
            const recentLows = candles.slice(Math.max(0, sweepIndex - 5), sweepIndex).map(c => c.low);
            lowestLow = Math.min(...recentLows, candles[sweepIndex].low);
        }
        mssTriggerPrice = lowestLow;
    }
    let mssConfirmed = false;
    let mssCandleIndex = -1;
    for (let j = sweepIndex; j < len; j++) {
        const c = candles[j];
        if (sweep.direction === "LONG") {
            if (c.close > mssTriggerPrice) {
                mssConfirmed = true;
                mssCandleIndex = j;
                break;
            }
        }
        else {
            if (c.close < mssTriggerPrice) {
                mssConfirmed = true;
                mssCandleIndex = j;
                break;
            }
        }
    }
    if (mssConfirmed) {
        const mssCandle = candles[mssCandleIndex];
        const breakDistance = Math.abs(mssCandle.close - mssTriggerPrice) / mssTriggerPrice;
        const strengthScore = Math.min(100, Math.round((sweep.pool.strength / 5) * 50 + (breakDistance * 1000) * 50));
        return {
            confirmed: true,
            direction: sweep.direction,
            mssPrice: mssTriggerPrice,
            candleIndex: mssCandleIndex,
            confidence: strengthScore
        };
    }
    return null;
}
function calculateDisplacement(candles, candleIndex) {
    if (candleIndex < 20 || candleIndex >= candles.length)
        return 0;
    const candle = candles[candleIndex];
    let sumBody = 0;
    let sumVolume = 0;
    for (let i = candleIndex - 20; i < candleIndex; i++) {
        sumBody += Math.abs(candles[i].close - candles[i].open);
        sumVolume += candles[i].volume;
    }
    const avgBody = sumBody / 20;
    const avgVolume = sumVolume / 20;
    const body = Math.abs(candle.close - candle.open);
    const range = candle.high - candle.low;
    const bodyRatio = avgBody > 0 ? (body / avgBody) : 1;
    const bodyToRangeRatio = range > 0 ? (body / range) : 1;
    const volumeRatio = avgVolume > 0 ? (candle.volume / avgVolume) : 1;
    const relativeBodyFactor = Math.min(2.0, bodyRatio) / 2.0;
    const relativeVolumeFactor = Math.min(2.0, volumeRatio) / 2.0;
    const bodyToRangeFactor = bodyToRangeRatio;
    const score = Math.round((relativeBodyFactor * 50) + (relativeVolumeFactor * 25) + (bodyToRangeFactor * 25));
    return score;
}
function updateFVGRegistry(candles, registry, currentTickPrice) {
    if (candles.length < 4)
        return registry;
    const len = candles.length;
    const i = len - 1;
    const c1 = candles[i - 2];
    const c2 = candles[i - 1];
    const c3 = candles[i];
    if (c3.low > c1.high && c2.close > c2.open) {
        const bottom = c1.high;
        const top = c3.low;
        const gap = top - bottom;
        const id = "FVG-BULL-" + c2.time;
        if (!registry.some(f => f.id === id)) {
            registry.push({
                id: id,
                creationTime: c2.time,
                direction: "BULLISH",
                top: top,
                bottom: bottom,
                initialGapSize: gap,
                mitigationPercent: 0,
                status: "ACTIVE"
            });
        }
    }
    if (c3.high < c1.low && c2.close < c2.open) {
        const bottom = c3.high;
        const top = c1.low;
        const gap = top - bottom;
        const id = "FVG-BEAR-" + c2.time;
        if (!registry.some(f => f.id === id)) {
            registry.push({
                id: id,
                creationTime: c2.time,
                direction: "BEARISH",
                top: top,
                bottom: bottom,
                initialGapSize: gap,
                mitigationPercent: 0,
                status: "ACTIVE"
            });
        }
    }
    const currentPrice = currentTickPrice || candles[len - 1].close;
    registry.forEach(f => {
        if (f.status === "MITIGATED")
            return;
        if (f.direction === "BULLISH") {
            let lowestPrice = currentPrice;
            for (let idx = len - 1; idx >= 0; idx--) {
                if (candles[idx].time < f.creationTime)
                    break;
                if (candles[idx].low < lowestPrice)
                    lowestPrice = candles[idx].low;
            }
            if (lowestPrice <= f.bottom) {
                f.mitigationPercent = 100;
                f.status = "MITIGATED";
            }
            else if (lowestPrice < f.top) {
                const mitigatedRange = f.top - lowestPrice;
                const percent = Math.round((mitigatedRange / f.initialGapSize) * 100);
                f.mitigationPercent = Math.max(f.mitigationPercent, percent);
                f.status = "PARTIAL";
            }
        }
        else {
            let highestPrice = currentPrice;
            for (let idx = len - 1; idx >= 0; idx--) {
                if (candles[idx].time < f.creationTime)
                    break;
                if (candles[idx].high > highestPrice)
                    highestPrice = candles[idx].high;
            }
            if (highestPrice >= f.top) {
                f.mitigationPercent = 100;
                f.status = "MITIGATED";
            }
            else if (highestPrice > f.bottom) {
                const mitigatedRange = highestPrice - f.bottom;
                const percent = Math.round((mitigatedRange / f.initialGapSize) * 100);
                f.mitigationPercent = Math.max(f.mitigationPercent, percent);
                f.status = "PARTIAL";
            }
        }
    });
    return registry;
}
function calculateDealingRange(sweepPrice, direction, candles) {
    const len = candles.length;
    if (direction === "LONG") {
        const rangeLow = sweepPrice;
        let highestHigh = -Infinity;
        for (let i = len - 1; i >= 0; i--) {
            if (candles[i].low <= sweepPrice) {
                break;
            }
            if (candles[i].high > highestHigh)
                highestHigh = candles[i].high;
        }
        if (highestHigh === -Infinity)
            highestHigh = candles[len - 1].high;
        const eq = (highestHigh + rangeLow) / 2;
        return { low: rangeLow, high: highestHigh, equilibrium: eq };
    }
    else {
        const rangeHigh = sweepPrice;
        let lowestLow = Infinity;
        for (let i = len - 1; i >= 0; i--) {
            if (candles[i].high >= sweepPrice) {
                break;
            }
            if (candles[i].low < lowestLow)
                lowestLow = candles[i].low;
        }
        if (lowestLow === Infinity)
            lowestLow = candles[len - 1].low;
        const eq = (rangeHigh + lowestLow) / 2;
        return { low: lowestLow, high: rangeHigh, equilibrium: eq };
    }
}
