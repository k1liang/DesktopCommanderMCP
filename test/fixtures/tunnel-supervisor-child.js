import fs from 'node:fs';

const [statePath, failuresText = '2'] = process.argv.slice(2);
const failures = Number(failuresText);
let attempts = 0;
try { attempts = Number(fs.readFileSync(statePath, 'utf8')) || 0; } catch {}
attempts += 1;
fs.writeFileSync(statePath, String(attempts));
process.exit(attempts <= failures ? 23 : 0);
