// The surfaces the CLI registers, from its own command table: the X-ray compares them with what it covered.
import { COMMAND_NAMES } from '../src/kit.mjs';

console.log(JSON.stringify({ cli: COMMAND_NAMES }, null, 2));
