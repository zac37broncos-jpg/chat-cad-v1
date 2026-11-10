import { describe, it, expect } from 'vitest';
import { evalLength, evalAngle, evaluate, formatLength, ExpressionError } from '../src/core/units';

describe('units and expressions', () => {
  it('converts inches exactly', () => {
    expect(evalLength('1 in', 'mm')).toBe(25.4);
    expect(evalLength('0.005"', 'mm')).toBeCloseTo(0.127, 15);
    expect(evalLength(2, 'in')).toBe(50.8);
  });
  it('bare numbers use the default unit, including when mixed', () => {
    expect(evalLength('0.5', 'in')).toBe(12.7);
    expect(evalLength('1 + 1 mm', 'in')).toBeCloseTo(26.4, 12);
    expect(evalLength('1/4', 'in')).toBe(6.35);
  });
  it('treats a fraction before a unit as one quantity', () => {
    expect(evalLength('1/4"', 'mm')).toBe(6.35);
    expect(evalLength('3/8 in', 'mm')).toBeCloseTo(9.525, 12);
    expect(evalLength('(1/4")/2', 'mm')).toBe(3.175);
    expect(evalLength('6/2 mm', 'in')).toBe(3);
    expect(evalLength('2 + 1/2"', 'mm')).toBeCloseTo(2 + 12.7, 12); // bare 2 takes the default unit
    expect(evalLength('2 + 1/2"', 'in')).toBeCloseTo(63.5, 12);
  });
  it('supports parameters and arithmetic', () => {
    const wall = { v: 3.175, dim: 'length' as const };
    expect(evalLength('2*wall + 0.25 in', 'in', { wall })).toBeCloseTo(12.7, 12);
    expect(evalLength('(3 - 1) * 2 mm', 'in')).toBe(4);
  });
  it('angles default to degrees', () => {
    expect(evalAngle('90')).toBeCloseTo(Math.PI / 2, 15);
    expect(evalAngle('pi rad')).toBeCloseTo(Math.PI, 15);
  });
  it('rejects bad input instead of guessing', () => {
    expect(() => evalLength('1 in + 30 deg', 'in')).toThrow(ExpressionError);
    expect(() => evalLength('abc', 'in')).toThrow(ExpressionError);
    expect(() => evalLength('1/0', 'in')).toThrow(ExpressionError);
    expect(() => evalLength('2 in in', 'in')).toThrow(ExpressionError);
  });
  it('formats to 4 decimals in inches', () => {
    expect(formatLength(25.4 * 0.0049999, 'in')).toBe('0.0050 in');
    expect(formatLength(-1e-9, 'in')).toBe('0.0000 in');
  });
});

describe('input slips with one meaning', () => {
  it('accepts Unicode minus/times and an expression wrapped in quotes', () => {
    expect(evalLength('\u22121', 'in')).toBe(-25.4);
    expect(evalLength('2\u00d73 mm', 'in')).toBe(6);
    expect(evalLength('"0.5"', 'in')).toBeCloseTo(12.7, 12);
    expect(evalLength("'W/2'", 'in', { W: { v: 50.8, dim: 'length' } } as any)).toBe(25.4);
    // An inch mark after a number is still an inch mark.
    expect(evalLength('1.25"', 'mm')).toBeCloseTo(31.75, 12);
  });
});

describe('angles in formulas', () => {
  const mm = (v: number) => ({ v, dim: 'length' as const });
  it('sin/cos/tan take an angle with a unit', () => {
    expect(evaluate('cos(60 deg)').v).toBeCloseTo(0.5, 15);
    expect(evaluate('sin((pi/2) rad)').v).toBeCloseTo(1, 15);
    expect(evalLength('100 mm * tan(45 deg)', 'mm')).toBeCloseTo(100, 12);
    expect(evalLength('10 * sin(30 deg)', 'in')).toBeCloseTo(127, 12);
  });
  it('rejects a bare number or a length inside trig instead of guessing radians', () => {
    expect(() => evaluate('cos(20)')).toThrow(/needs an angle/);
    expect(() => evaluate('sin(1 in)')).toThrow(/not a length/);
    expect(() => evaluate('cos(pi)')).toThrow(ExpressionError);
  });
  it('a unitless parameter is flagged, and "name deg" reads it as degrees', () => {
    const lean = { v: 20 * 25.4, dim: 'length' as const, bare: 20 };
    expect(() => evaluate('cos(lean)', { lean })).toThrow(/defined without a unit/);
    expect(evaluate('cos(lean deg)', { lean }).v).toBeCloseTo(Math.cos((20 * Math.PI) / 180), 15);
    expect(evalAngle('lean deg', { lean })).toBeCloseTo((20 * Math.PI) / 180, 15);
  });
  it('an angle parameter works directly; adding a redundant unit gives a clear error', () => {
    const a = { v: (20 * Math.PI) / 180, dim: 'angle' as const };
    expect(evaluate('cos(a)', { a }).v).toBeCloseTo(Math.cos(a.v), 15);
    expect(evaluate('90 deg - a', { a }).v).toBeCloseTo((70 * Math.PI) / 180, 15);
    expect(() => evaluate('cos(a deg)', { a })).toThrow(/already has a unit/);
    expect(() => evaluate('cos(w deg)', { w: mm(5) })).toThrow(/already has a unit/);
  });
  it('inverse trig returns an angle', () => {
    expect(evalAngle('asin(0.5)')).toBeCloseTo(Math.PI / 6, 15);
    expect(evalAngle('atan(1)')).toBeCloseTo(Math.PI / 4, 15);
    expect(() => evaluate('acos(1 mm)')).toThrow(ExpressionError);
  });
  it('area gives a clear message', () => {
    expect(() => evalLength('2 mm * 3 mm', 'mm')).toThrow(/area/);
  });
});
