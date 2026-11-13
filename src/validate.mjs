// The subset of JSON Schema that Reins' action inputs use, and the `until` check batch steps share.
// Messages name the JSON path of the bad value, so an agent can fix that one input.

export function validate(schema, value, at = '$') {
  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { path: at, message: `${at}: expected an object` };
    for (const k of schema.required || []) if (!(k in value)) return { path: `${at}.${k}`, message: `${at}.${k}: required` };
    for (const [k, v] of Object.entries(value)) {
      const sub = (schema.properties || {})[k];
      if (!sub) {
        if (schema.additionalProperties === false) return { path: `${at}.${k}`, message: `${at}.${k}: not an input of this action (inputs: ${Object.keys(schema.properties || {}).join(', ') || 'none'})` };
        continue;
      }
      const e = validate(sub, v, `${at}.${k}`);
      if (e) return e;
    }
    return null;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return { path: at, message: `${at}: expected an array` };
    if (schema.minItems != null && value.length < schema.minItems) return { path: at, message: `${at}: at least ${schema.minItems} items` };
    if (schema.maxItems != null && value.length > schema.maxItems) return { path: at, message: `${at}: at most ${schema.maxItems} items` };
    for (let i = 0; i < value.length; i++) { const e = validate(schema.items || {}, value[i], `${at}[${i}]`); if (e) return e; }
    return null;
  }
  if (schema.enum && !schema.enum.includes(value)) return { path: at, message: `${at}: ${JSON.stringify(value)} isn't one of ${schema.enum.map((x) => JSON.stringify(x)).join(', ')}` };
  if (schema.type === 'string') {
    if (typeof value !== 'string') return { path: at, message: `${at}: expected a string` };
    if (schema.minLength && value.length < schema.minLength) return { path: at, message: `${at}: must not be empty` };
    if (schema.maxLength != null && value.length > schema.maxLength) return { path: at, message: `${at}: at most ${schema.maxLength} characters` };
  }
  if (schema.type === 'boolean' && typeof value !== 'boolean') return { path: at, message: `${at}: expected true or false` };
  if (schema.type === 'integer') {
    if (!Number.isInteger(value)) return { path: at, message: `${at}: expected an integer` };
    if (schema.minimum != null && value < schema.minimum) return { path: at, message: `${at}: at least ${schema.minimum}` };
    if (schema.maximum != null && value > schema.maximum) return { path: at, message: `${at}: at most ${schema.maximum}` };
  }
  return null;
}

// `until` is { "<dotted path into the screen>": <expected value> }; arrays compare by length when expected is a number.
export function holds(until, view) {
  if (!until) return true;
  return Object.entries(until).every(([p, want]) => {
    const got = p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), view);
    if (Array.isArray(got) && typeof want === 'number') return got.length === want;
    return JSON.stringify(got) === JSON.stringify(want);
  });
}
