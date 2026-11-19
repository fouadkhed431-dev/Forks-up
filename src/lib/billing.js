export const cleanItemLabel = (name = '') => String(name)
  .normalize('NFKC')
  .trim()
  // Remove menu numbering such as "1.1 ", "3. " or "2-1 "
  .replace(/^\s*\d+(?:[.)-]\d+)*[.)-]?\s+/, '')
  .replace(/\s+/g, ' ')
  .trim();

export const normalizeItemName = (name = '') => cleanItemLabel(name)
  .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
  .replace(/[أإآٱ]/g, 'ا')
  .replace(/ى/g, 'ي')
  .replace(/[.,،؛:!?؟()[\]{}"'`]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .toLocaleLowerCase('ar');
export const money = value => `${Number(value || 0).toFixed(2)} ج.م`;

export function aggregateItems(orders = []) {
  const grouped = new Map();
  for (const order of orders) {
    for (const item of order.order_items || order.items || []) {
      const key = normalizeItemName(item.description);
      if (!key) continue;
      const current = grouped.get(key) || { key, label: item.description.trim(), quantity: 0 };
      current.quantity += Number(item.quantity) || 1;
      grouped.set(key, current);
    }
  }
  return [...grouped.values()].sort((a, b) => a.label.localeCompare(b.label, 'ar'));
}

export function getParticipants(orders = []) {
  const names = new Set();
  for (const order of orders) {
    if (order.employee_name?.trim()) names.add(order.employee_name.trim());
    for (const item of order.order_items || order.items || []) {
      if (item.kind === 'shared') for (const name of item.participants || []) if (name?.trim()) names.add(name.trim());
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b, 'ar'));
}

function allocateCents(total, names) {
  const result = new Map();
  if (!names.length) return result;
  const cents = Math.max(0, Math.round((Number(total) || 0) * 100));
  const base = Math.floor(cents / names.length);
  const remainder = cents - base * names.length;
  names.forEach((name, index) => result.set(name, (base + (index < remainder ? 1 : 0)) / 100));
  return result;
}

export function calculateBills(orders = [], prices = {}, deliveryFee = 0) {
  const people = getParticipants(orders);
  const bills = Object.fromEntries(people.map(name => [name, { name, items: [], subtotal: 0, delivery: 0, total: 0 }]));

  for (const order of orders) {
    const owner = order.employee_name;
    for (const item of order.order_items || order.items || []) {
      const unit = Number(prices[normalizeItemName(item.description)] ?? 0);
      const quantity = Math.max(1, Number(item.quantity) || 1);
      const lineTotal = unit * quantity;
      const shared = item.kind === 'shared';
      const participants = shared
        ? [...new Set([...(item.participants || []), owner].map(x => x?.trim()).filter(Boolean))]
        : [owner];
      const allocations = allocateCents(lineTotal, participants);
      for (const person of participants) {
        const share = allocations.get(person) || 0;
        if (!bills[person]) bills[person] = { name: person, items: [], subtotal: 0, delivery: 0, total: 0 };
        bills[person].subtotal += share;
        bills[person].items.push({
          description: item.description,
          quantity,
          shared,
          participants,
          amount: share,
          lineTotal
        });
      }
    }
  }

  const delivery = Math.max(0, Number(deliveryFee) || 0);
  const deliveryAllocations = allocateCents(delivery, people);
  for (const person of people) {
    bills[person].delivery = deliveryAllocations.get(person) || 0;
    bills[person].total = Math.round((bills[person].subtotal + bills[person].delivery) * 100) / 100;
  }
  return { people, bills, deliveryShare: people.length ? delivery / people.length : 0, grandTotal: Math.round(Object.values(bills).reduce((sum, bill) => sum + bill.total, 0) * 100) / 100 };
}
