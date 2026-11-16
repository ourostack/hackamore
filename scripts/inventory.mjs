// The surfaces the CLI registers, from its own command table: the X-ray compares them with what it covered.
import { COMMANDS } from '../src/cli.mjs';

console.log(JSON.stringify({ cli: COMMANDS.map((c) => c.name) }, null, 2));
