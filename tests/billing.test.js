import { describe, expect, it } from 'vitest';
import { aggregateItems, calculateBills, getParticipants, normalizeItemName } from '../src/lib/billing.js';

const orders = [
  { employee_name: 'أحمد', order_items: [
    { description: 'بيتزا', quantity: 1, kind: 'shared', participants: ['أحمد', 'محمد'] },
    { description: 'كولا', quantity: 2, kind: 'individual', participants: [] }
  ] },
  { employee_name: 'محمد', order_items: [
    { description: 'برجر', quantity: 1, kind: 'individual', participants: [] }
  ] }
];

describe('Forks Up billing rules', () => {
  it('normalizes names for matching invoice lines', () => {
    expect(normalizeItemName('  بيتزا   كبيرة ')).toBe('بيتزا كبيرة');
  });
  it('aggregates identical items and quantities', () => {
    const rows = aggregateItems([
      ...orders,
      { employee_name: 'سارة', order_items: [{ description: 'كولا', quantity: 1, kind: 'individual', participants: [] }] }
    ]);
    expect(rows.find(row => row.key === 'كولا').quantity).toBe(3);
  });
  it('splits shared item cost equally and charges individual items to the owner', () => {
    const { bills } = calculateBills(orders, { بيتزا: 100, كولا: 10, برجر: 80 }, 20);
    expect(bills['أحمد'].subtotal).toBe(70); // 50 shared + 20 cola
    expect(bills['محمد'].subtotal).toBe(130); // 50 shared + 80 burger
  });
  it('splits delivery equally among all round participants', () => {
    const { bills, deliveryShare } = calculateBills(orders, { بيتزا: 100, كولا: 10, برجر: 80 }, 21);
    expect(deliveryShare).toBe(10.5);
    expect(bills['أحمد'].total).toBe(80.5);
    expect(bills['محمد'].total).toBe(140.5);
  });
  it('includes shared participants even if they did not submit a separate order', () => {
    const data = [{ employee_name: 'أحمد', order_items: [{ description: 'وجبة', quantity: 1, kind: 'shared', participants: ['أحمد', 'سارة'] }] }];
    expect(getParticipants(data)).toEqual(['أحمد', 'سارة']);
    const { bills } = calculateBills(data, { وجبة: 60 }, 10);
    expect(bills['سارة'].total).toBe(35);
  });
});

describe('currency rounding', () => {
  it('distributes indivisible piastres without losing invoice value', () => {
    const data = [{ employee_name: 'أ', order_items: [{ description: 'طبق', quantity: 1, kind: 'shared', participants: ['أ', 'ب', 'ج'] }] }];
    const { bills, grandTotal } = calculateBills(data, { طبق: 10 }, 0);
    expect(Object.values(bills).reduce((sum, bill) => sum + bill.total, 0)).toBe(10);
    expect(grandTotal).toBe(10);
  });
});


describe('billing edge cases before release', () => {
  it('deduplicates shared participants and includes the order owner once', () => {
    const data = [{
      employee_name: 'أحمد',
      order_items: [{
        description: 'وجبة جماعية',
        quantity: 1,
        kind: 'shared',
        participants: ['أحمد', 'محمد', 'محمد', 'سارة']
      }]
    }];
    const { people, bills, grandTotal } = calculateBills(data, { 'وجبة جماعية': 100 }, 0);
    expect(people).toHaveLength(3);
    expect(bills['أحمد'].total + bills['محمد'].total + bills['سارة'].total).toBe(100);
    expect(grandTotal).toBe(100);
  });

  it('keeps item and delivery allocations equal to the entered totals after cent rounding', () => {
    const data = [{
      employee_name: 'أحمد',
      order_items: [{
        description: 'طبق مشترك',
        quantity: 2,
        kind: 'shared',
        participants: ['أحمد', 'محمد', 'سارة']
      }]
    }];
    const { bills, grandTotal } = calculateBills(data, { 'طبق مشترك': 10.01 }, 10);
    const sum = Object.values(bills).reduce((total, bill) => total + bill.total, 0);
    expect(sum).toBe(30.02);
    expect(grandTotal).toBe(30.02);
  });

  it('returns a safe zero-value result for a round with no orders', () => {
    const result = calculateBills([], {}, 25);
    expect(result.people).toEqual([]);
    expect(result.bills).toEqual({});
    expect(result.grandTotal).toBe(0);
  });
});
