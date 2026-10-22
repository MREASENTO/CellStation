'use strict';
const path = require('node:path');
const root = process.env.CELLSTATION_DATA_ROOT || path.resolve(__dirname, '..');
module.exports = { root, work: path.join(root, 'work'), outputs: path.join(root, 'outputs') };
