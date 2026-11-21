// The fuel price pulled from the model's answer, and what it costs per km / mile.
import assert from 'node:assert/strict';
import { parseFuel, costPerDistance } from '../app/src/main/assets/www/local/fuel.js';
import { currencyFor } from '../app/src/main/assets/www/local/delivery.js';
assert.deepEqual(parseFuel('Sure: {"price": "1,150", "unit": "litre", "source": "NNPC"}'), { price: 1150, unit: 'litre', source: 'NNPC' });
assert.equal(parseFuel('{"price": 0}'), null);
assert.equal(parseFuel('no idea'), null);
assert.equal(parseFuel('{"price": 3.49, "unit": "gallon"}').unit, 'gallon');
assert.equal(Math.round(costPerDistance({ price: 1200, unit: 'litre' }, 12, 'km')), 100);          // 12 km a litre at 1200 a litre
assert.equal(costPerDistance({ price: 3.5, unit: 'gallon' }, 28, 'mile').toFixed(3), '0.125');    // 28 mpg at 3.50 a gallon
assert.equal(costPerDistance({ price: 0, unit: 'litre' }, 12, 'km'), 0);
assert.equal(currencyFor('NG'), '₦'); assert.equal(currencyFor('fr'), '€'); assert.equal(currencyFor('gb'), '£'); assert.equal(currencyFor('zz'), '');
process.stdout.write('fuel OK\n');
