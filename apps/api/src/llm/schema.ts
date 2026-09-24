// OpenAI strict-mode schema transform (AMENDMENTS A7). The registry keeps ONE canonical schema
// (Anthropic style: additionalProperties:false, required listed). OpenAI strict mode demands that
// every property is required and every object closes additionalProperties, so optional properties
// become required-but-nullable (`type: [T, 'null']`); executors treat null as absent.

type Json = Record<string, unknown>;

export function toStrictSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return strictify(schema);
}

function strictify(node: Json): Json {
  const { default: _default, ...rest } = node;   // `default` is rejected by strict mode
  const out: Json = { ...rest };
  if (isObjectSchema(out)) {
    const properties = (out.properties as Record<string, Json> | undefined) ?? {};
    const required = new Set((out.required as string[] | undefined) ?? []);
    const strictProps: Record<string, Json> = {};
    for (const [key, prop] of Object.entries(properties)) {
      const child = strictify(prop);
      strictProps[key] = required.has(key) ? child : nullable(child);
    }
    out.type = 'object';
    out.properties = strictProps;
    out.required = Object.keys(properties);
    out.additionalProperties = false;
  }
  if (out.type === 'array' && isJson(out.items)) out.items = strictify(out.items);
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = out[key];
    if (Array.isArray(branches)) out[key] = branches.map((b) => (isJson(b) ? strictify(b) : b));
  }
  return out;
}

function nullable(node: Json): Json {
  for (const key of ['anyOf', 'oneOf'] as const) {
    const branches = node[key];
    if (Array.isArray(branches)) {
      const hasNull = branches.some((b) => isJson(b) && b.type === 'null');
      return hasNull ? node : { ...node, [key]: [...branches, { type: 'null' }] };
    }
  }
  const type = node.type;
  if (typeof type === 'string') return withNullEnum({ ...node, type: type === 'null' ? type : [type, 'null'] });
  if (Array.isArray(type)) return withNullEnum({ ...node, type: type.includes('null') ? type : [...type, 'null'] });
  return { anyOf: [node, { type: 'null' }] };
}

function withNullEnum(node: Json): Json {
  const values = node.enum;
  if (!Array.isArray(values) || values.includes(null)) return node;
  return { ...node, enum: [...values, null] };
}

const isJson = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isObjectSchema = (node: Json): boolean => node.type === 'object' || isJson(node.properties);
