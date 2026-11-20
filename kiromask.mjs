#!/usr/bin/env node
import { main } from './_kiromask-src/cli.mjs';
const META = { name: 'kiromask', version: '2.1' };
main(process.argv.slice(2), META).catch((e) => { console.error(`\nFatal: ${e.message}`); process.exit(1); });
