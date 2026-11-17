// Node refuses to strip types from a .ts file under node_modules, and an install from GitHub puts this package there while
// the Ouro AX kit in lib/ is .ts. This hook strips them itself, only for that kit, so an installed copy runs the same as a clone.
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const KIT = '/lib/ouro-ui/registry/ouro/ax/';

registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith('file:') && url.endsWith('.ts') && url.includes(KIT) && url.includes('/node_modules/')) {
      const source = stripTypeScriptTypes(fs.readFileSync(fileURLToPath(url), 'utf8'));
      return { format: 'module', source, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
