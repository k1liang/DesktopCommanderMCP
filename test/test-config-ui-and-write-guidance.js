import assert from 'node:assert/strict';
import { server } from '../dist/server.js';
import { DEFAULT_FILE_READ_LINE_LIMIT, DEFAULT_FILE_WRITE_LINE_LIMIT } from '../dist/config-field-definitions.js';

async function run() {
    assert.equal(DEFAULT_FILE_READ_LINE_LIMIT, 5000);
    assert.equal(DEFAULT_FILE_WRITE_LINE_LIMIT, 2000);
    const handler = server._requestHandlers.get('tools/list');
    assert.ok(handler, 'tools/list handler registered');
    const result = await handler({ method: 'tools/list', params: {} }, {});
    const getConfig = result.tools.find(tool => tool.name === 'get_config');
    const writeFile = result.tools.find(tool => tool.name === 'write_file');
    const readFile = result.tools.find(tool => tool.name === 'read_file');
    assert.ok(getConfig && writeFile && readFile, 'expected MCP tools');
    assert.ok(!getConfig._meta?.['ui/resourceUri'] && !getConfig._meta?.['openai/outputTemplate'], 'get_config must not open the config UI');
    assert.match(getConfig.description, /default read_file lines: 5000/);
    assert.match(getConfig.description, /warning threshold: 2000/);
    assert.doesNotMatch(writeFile.description, /CHUNKING IS STANDARD PRACTICE|Always write files in chunks|Files over 50 lines/);
    assert.match(writeFile.description, /prefer one write_file call/);
    assert.match(readFile.description, /initially 5000/);
    console.log('PASS: no auto config UI, consistent defaults, no micro-chunking tool guidance');
}

run().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
