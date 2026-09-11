// ===== 自动化测试总控：node tests/run-all.js [套件名] =====
'use strict';
const { runAll } = require('./helpers');
require('./test-filters');
require('./test-background');
require('./test-content-search');
require('./test-content-chat');
require('./test-sidepanel');
require('./test-upgrade');
require('./test-review');
runAll(process.argv[2]);
