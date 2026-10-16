import path from 'path';
import os from 'os';

// Use user's home directory for configuration files
export const USER_HOME = os.homedir();
const CONFIG_DIR = path.join(USER_HOME, '.claude-server-commander');

// Paths relative to the config directory
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
export const TOOL_CALL_FILE = path.join(CONFIG_DIR, 'claude_tool_call.log');
export const TOOL_CALL_FILE_MAX_SIZE = 1024 * 1024 * 10; // 10 MB

export const DEFAULT_COMMAND_TIMEOUT = 1000; // milliseconds

// A process wait is a polling operation, not a lease on an MCP dispatcher slot.
// Keep each call short so several long-running sessions cannot starve unrelated
// MCP tools behind a shared tunnel-client concurrency pool. The process keeps
// running and callers continue with read_process_output.
export const MAX_PROCESS_WAIT_MS = 5000;
