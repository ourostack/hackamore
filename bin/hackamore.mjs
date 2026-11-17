#!/usr/bin/env node
await import('../src/ts-hook.mjs');
const { main } = await import('../src/cli.mjs');

// A reader that closes the pipe early (head, a pager) is not an error.
process.stdout.on('error', (e) => { if (e.code !== 'EPIPE') throw e; process.exit(process.exitCode ?? 0); });

process.exitCode = await main(process.argv.slice(2));
// The resident engine child and open sockets would keep node alive; the command is done.
setTimeout(() => process.exit(process.exitCode), 50).unref();
