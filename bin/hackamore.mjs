#!/usr/bin/env node
import { main } from '../src/cli.mjs';

process.exitCode = await main(process.argv.slice(2));
// The resident engine child and open sockets would keep node alive; the command is done.
setTimeout(() => process.exit(process.exitCode), 50).unref();
