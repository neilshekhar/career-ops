#!/usr/bin/env node

import assert from 'node:assert/strict';

import { applyCvDesignStyle } from '../generate-pdf.mjs';

const html = '<html><head></head><body><div class="header-gradient"></div></body></html>';

assert.equal(applyCvDesignStyle(html, 'standard'), html);

const conservative = applyCvDesignStyle(html, 'conservative');
assert(conservative.includes('career-ops-cv-style'));
assert(conservative.includes('.header-gradient { background: #263238 !important; }'));
assert(conservative.indexOf('career-ops-cv-style') < conservative.indexOf('</head>'));

assert.throws(() => applyCvDesignStyle(html, 'decorative'), /Invalid CV style/);

console.log('generate-pdf style tests passed');
