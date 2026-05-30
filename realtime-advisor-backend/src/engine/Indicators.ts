export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface FVG {
  low: number;
  high: number;
}

export interface OrderBlock {
  index: number;
  low: number;
  high: number;
  unmitigated: boolean;
}

export function calculateEMA(data: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const ema = [data[0]];
  for (let i = 1; i < data.length; i++) {
    ema.push(data[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

export function calculateRSI(closes: number[], period: number = 14): number[] {
  const rsi: number[] = [];
  if (closes.length <= period) return rsi;
  
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
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

export function calculateMACD(closes: number[]): { macd: number[]; signal: number[] } {
  const ema12 = calculateEMA(closes, 12);
  const ema26 = calculateEMA(closes, 26);
  const macd: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    macd.push(ema12[i] - ema26[i]);
  }
  const signal = calculateEMA(macd.slice(26), 9);
  const paddedSignal = new Array(26).fill(0).concat(signal);
  return { macd, signal: paddedSignal };
}

export function calculateATR(candles: Candle[], period: number = 14): number[] {
  const len = candles.length;
  const atr = new Array(len).fill(0);
  if (len === 0) return atr;
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
  for (let i = 0; i < limit; i++) sum += tr[i];
  const initialAtr = sum / limit;
  for (let i = 0; i < limit; i++) atr[i] = initialAtr;
  for (let i = period; i < len; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  }
  return atr;
}

export function detectLiquiditySweep(candles: Candle[]): { bullishSweep: boolean; bearishSweep: boolean; level: number } {
  const len = candles.length;
  if (len < 30) return { bullishSweep: false, bearishSweep: false, level: 0 };
  const current = candles[len - 1];
  const lookback = candles.slice(len - 31, len - 1);
  const highestHigh = Math.max(...lookback.map(c => c.high));
  const lowestLow = Math.min(...lookback.map(c => c.low));
  
  const currentRange = current.high - current.low;
  if (currentRange <= 0) return { bullishSweep: false, bearishSweep: false, level: 0 };

  const isBullishSweep = current.low < lowestLow && current.close > lowestLow && (current.close - current.low) / currentRange >= 0.5;
  const isBearishSweep = current.high > highestHigh && current.close < highestHigh && (current.high - current.close) / currentRange >= 0.5;
  
  if (isBullishSweep) return { bullishSweep: true, bearishSweep: false, level: lowestLow };
  if (isBearishSweep) return { bullishSweep: false, bearishSweep: true, level: highestHigh };
  return { bullishSweep: false, bearishSweep: false, level: 0 };
}

export function detectOrderBlocks(candles: Candle[]): { bullish: OrderBlock[]; bearish: OrderBlock[] } {
  const bullish: OrderBlock[] = [];
  const bearish: OrderBlock[] = [];
  const len = candles.length;
  
  for (let i = 5; i < len - 2; i++) {
    const c = candles[i];
    const cNext = candles[i + 1];
    const cNext2 = candles[i + 2];
    const isDown = c.close < c.open;
    const isStrongUp = cNext.close > cNext.open && cNext2.close > cNext2.open && cNext2.close > candles[i - 1].high;
    if (isDown && isStrongUp) bullish.push({ index: i, low: c.low, high: c.high, unmitigated: true });
    
    const isUp = c.close > c.open;
    const isStrongDown = cNext.close < cNext.open && cNext2.close < cNext2.open && cNext2.close < candles[i - 1].low;
    if (isUp && isStrongDown) bearish.push({ index: i, low: c.low, high: c.high, unmitigated: true });
  }
  
  bullish.forEach(ob => {
    for (let j = ob.index + 2; j < len; j++) {
      if (candles[j].low < ob.low) { ob.unmitigated = false; break; }
    }
  });
  
  bearish.forEach(ob => {
    for (let j = ob.index + 2; j < len; j++) {
      if (candles[j].high > ob.high) { ob.unmitigated = false; break; }
    }
  });
  
  return { bullish, bearish };
}

export function detectFVG(candles: Candle[]): { bullishGap: FVG | null; bearishGap: FVG | null } {
  const len = candles.length;
  if (len < 5) return { bullishGap: null, bearishGap: null };
  const c1 = candles[len - 4];
  const c2 = candles[len - 3];
  const c3 = candles[len - 2];
  let bullishGap: FVG | null = null;
  let bearishGap: FVG | null = null;
  if (c3.low > c1.high && c2.close > c2.open) bullishGap = { low: c1.high, high: c3.low };
  if (c3.high < c1.low && c2.close < c2.open) bearishGap = { low: c3.high, high: c1.low };
  return { bullishGap, bearishGap };
}
