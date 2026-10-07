'use strict';
// Run with: node tests/customer-pricing.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../order-entry.js'), 'utf8');
const start = source.indexOf('function pricingUnits(');
const end = source.indexOf('function installCustomerPricing(');
assert.ok(start >= 0 && end > start, 'Pricing helpers must be present');
const context = vm.createContext({ Intl });
vm.runInContext(source.slice(start, end), context);
const price = (base, percent) => JSON.parse(JSON.stringify(context.calculateCustomerPricing(base, percent)));
assert.deepEqual(price('40000', '9'), { customer_base_price: 40000, customer_diesel_percent: 9, customer_diesel_amount: 3600, customer_price: 43600 });
assert.equal(price('46500', '8,75').customer_price, 50568.75);
assert.equal(price('0.05', '10').customer_diesel_amount, 0.01);
assert.equal(price('100,01', '9,25').customer_price, 109.26);
assert.equal(price('40000', '').customer_price, 40000);
assert.equal(price('0', '9').customer_price, 0);
assert.equal(price('', '').customer_price, null);
for (const [base, percent] of [['40000', '-1'], ['40000', '100.01'], ['40000', 'abc'], ['40000', '9.999'], ['', '9'], ['-1', '9'], ['NaN', '9']]) {
  assert.throws(() => price(base, percent));
}
const saved = price('40000', '9');
assert.deepEqual(price(saved.customer_base_price, saved.customer_diesel_percent), saved);
assert.equal(price(saved.customer_base_price, '').customer_price, 40000);
assert.equal(price('50000', saved.customer_diesel_percent).customer_price, 54500);
assert.ok(source.includes('order.customer_base_price ?? order.customer_price'), 'Editing must use base, not the previous total');
assert.ok(source.includes('delete pricing.customer_diesel_amount'), 'Generated amount must not be sent to the database');
console.log('PASS: customer diesel calculation, decimal comma, rounding, validation and non-compounding edits');
