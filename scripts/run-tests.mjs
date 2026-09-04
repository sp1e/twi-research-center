#!/usr/bin/env node
import { spawn } from 'node:child_process';

const SUITES = [
  'test:twi',
  'test:twi:schema',
  'test:twi:structure',
  'test:twi:contracts',
  'test:stems:finish',
  'test:twi:orchestrator:guard',
  'test:twi:orchestrator',
  'test:twi:bundle',
];

const npmCli = process.env.npm_execpath;

const run = (script) => new Promise((resolve) => {
  console.log(`\n--- ${script} ---`);
  const child = spawn(
    npmCli ? process.execPath : 'npm',
    npmCli ? [npmCli, 'run', script] : ['run', script],
    { stdio: 'inherit', shell: !npmCli },
  );
  child.on('error', (error) => {
    console.error(error.message);
    resolve(1);
  });
  child.on('close', (code) => resolve(code ?? 1));
});

for (const suite of SUITES) {
  const status = await run(suite);
  if (status !== 0) {
    console.error(`\nFAILED: ${suite}`);
    process.exit(status);
  }
}

console.log(`\nALL TWI SUITES PASSED (${SUITES.length}/${SUITES.length})`);

