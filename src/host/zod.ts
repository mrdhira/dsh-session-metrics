// @ts-nocheck -- deliberately unchecked.
//
// This file is a hand-written stand-in for `schemastery`, which is not resolvable from a
// profile directory: it implements the Host's native-schema brand (own enumerable `meta`,
// `type`, `dict`, `inner`, `list` accessors, the `[kSchema]` brand and `.volatile()`) with
// dynamic nodes. Typing that dynamic surface statically would mean restating schemastery's
// generics for no runtime benefit, so the file is excluded from the type check by intent.
//
// What protects it is not the compiler but the tests: `settings.test.js` and `schema.test.js`
// drive the real Host projector over this graph (including the volatile placement rule and
// `status: "schema"` in `Config.listConfigs`).
/**
 * Minimal local validation toolkit for the session-metrics plugin.
 *
 * The desktop profile has no shared `node_modules`, so the plugin cannot import
 * the Host's schema library. This module provides the small slice of the
 * `zod`-style surface the plugin needs — `parse` for validation with defaults and
 * `toJSON` for tooling — with no dependencies.
 *
 * The `~standard` interface is installed as an own enumerable property rather
 * than a prototype getter, because a loader that copies only own enumerable
 * exports would otherwise drop it. The bundle's own entry point still does not
 * export `Config`, so activation never depends on it.
 */

/** Raised when a configuration value does not satisfy its schema. */
export class SchemaError extends Error {
  /** Dynamic by design: the node mirrors schemastery's own dynamic shape. */
  [key: string]: any;
  /**
   * @param path - dotted path to the offending value.
   * @param detail - what was expected.
   */
  constructor(path, detail) {
    super(`session-metrics config: ${path || '<root>'} ${detail}`);
    this.name = 'SchemaError';
    this.path = path;
  }
}

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

/** Build a JSON-Schema fragment for one descriptor. */
function jsonOf(kind, meta) {
  const base = { ...(meta.description === undefined ? {} : { description: meta.description }) };
  if (kind.type === 'object') return { type: 'object', properties: kind.shape, additionalProperties: false, ...base };
  if (kind.type === 'array') return { type: 'array', items: kind.item, ...base };
  if (kind.type === 'record') return { type: 'object', additionalProperties: kind.values, ...base };
  if (kind.type === 'union') return { anyOf: kind.options, ...base };
  if (kind.type === 'tuple') {
    return { type: 'array', prefixItems: kind.items, minItems: kind.items.length, maxItems: kind.items.length, ...base };
  }
  const out: Record<string, any> = { type: kind.type, ...base };
  if (kind.enum !== undefined) out.enum = kind.enum;
  if (kind.min !== undefined) out.minimum = kind.min;
  if (kind.max !== undefined) out.maximum = kind.max;
  return out;
}

/** Parsing behavior for one descriptor kind. */
const handlers = {
  object(descriptor, value, path) {
    const absent = value === undefined || value === null;
    const input = absent ? (descriptor.default === undefined ? {} : clone(descriptor.default)) : value;
    if (absent && descriptor.optional) return undefined;
    if (typeof input !== 'object' || Array.isArray(input)) throw new SchemaError(path, 'must be an object');
    const out = {};
    for (const [key, rawChild] of Object.entries(descriptor.shape)) {
      const child = descriptorOf(rawChild);
      const childPath = path === '' ? key : `${path}.${key}`;
      const present = hasOwn(input, key) && input[key] !== undefined;
      out[key] = present ? parseWith(child, input[key], childPath) : parseWith(child, undefined, childPath);
    }
    for (const key of Object.keys(input)) {
      if (!hasOwn(descriptor.shape, key) && descriptor.strict !== false) {
        throw new SchemaError(path === '' ? key : `${path}.${key}`, 'is not a known field');
      }
    }
    return out;
  },
  array(descriptor, value, path) {
    if (!Array.isArray(value)) throw new SchemaError(path, 'must be an array');
    return value.map((item, index) => parseWith(descriptor.item, item, `${path}[${index}]`));
  },
  record(descriptor, value, path) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new SchemaError(path, 'must be an object');
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = parseWith(descriptor.values, item, path === '' ? key : `${path}.${key}`);
    }
    return out;
  },
  tuple(descriptor, value, path) {
    if (!Array.isArray(value) || value.length !== descriptor.items.length) {
      throw new SchemaError(path, `must be an array of ${descriptor.items.length} items`);
    }
    return value.map((item, index) => parseWith(descriptor.items[index], item, `${path}[${index}]`));
  },
  union(descriptor, value, path) {
    const errors = [];
    for (const option of descriptor.options) {
      try {
        return parseWith(option, value, path);
      } catch (error) {
        errors.push(error.message);
      }
    }
    throw new SchemaError(path, `matched no allowed form (${errors.join('; ')})`);
  },
  string(descriptor, value, path) {
    if (typeof value !== 'string') throw new SchemaError(path, 'must be a string');
    if (descriptor.enum !== undefined && !descriptor.enum.includes(value)) {
      throw new SchemaError(path, `must be one of ${descriptor.enum.join(', ')}`);
    }
    return value;
  },
  number(descriptor, value, path) {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new SchemaError(path, 'must be a number');
    if (descriptor.min !== undefined && value < descriptor.min) throw new SchemaError(path, `must be >= ${descriptor.min}`);
    if (descriptor.max !== undefined && value > descriptor.max) throw new SchemaError(path, `must be <= ${descriptor.max}`);
    if (descriptor.exclusiveMin !== undefined && value <= descriptor.exclusiveMin) {
      throw new SchemaError(path, `must be > ${descriptor.exclusiveMin}`);
    }
    return value;
  },
  integer(descriptor, value, path) {
    const number = handlers.number(descriptor, value, path);
    if (!Number.isInteger(number)) throw new SchemaError(path, 'must be an integer');
    return number;
  },
  boolean(descriptor, value, path) {
    if (typeof value !== 'boolean') throw new SchemaError(path, 'must be a boolean');
    return value;
  },
  nullable(descriptor, value, path) {
    if (value === null || value === undefined) return null;
    return parseWith(descriptor.inner, value, path);
  },
  any(_descriptor, value) {
    return value;
  },
  null(_descriptor, value, path) {
    if (value !== null) throw new SchemaError(path, 'must be null');
    return null;
  },
};

/** Deep-clone a default so callers never share mutable state. */
function clone(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(clone);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
}

/** Accept either a raw descriptor or a chainable schema value. */
function descriptorOf(value) {
  return value instanceof SchemaValue ? value.shape : value;
}

/** Validate one value against one descriptor. */
function parseWith(rawDescriptor, value, path) {
  const descriptor = descriptorOf(rawDescriptor);
  let input = value;
  if (input === undefined) {
    if (descriptor.optional) return undefined;
    if (descriptor.default === undefined) throw new SchemaError(path, 'is required');
    input = typeof descriptor.default === 'function' ? descriptor.default() : clone(descriptor.default);
  }
  if (descriptor.type === 'object') {
    const shape = Object.fromEntries(Object.entries(descriptor.shape).map(([key, child]) => [key, descriptorOf(child)]));
    return handlers.object({ ...descriptor, shape }, input, path);
  }
  if (descriptor.type === 'array') return handlers.array({ ...descriptor, item: descriptorOf(descriptor.item) }, input, path);
  if (descriptor.type === 'tuple') return handlers.tuple({ ...descriptor, items: descriptor.items.map(descriptorOf) }, input, path);
  if (descriptor.type === 'union') return handlers.union({ ...descriptor, options: descriptor.options.map(descriptorOf) }, input, path);
  if (descriptor.type === 'nullable') return handlers.nullable({ ...descriptor, inner: descriptorOf(descriptor.inner) }, input, path);
  if (descriptor.type === 'record') return handlers.record({ ...descriptor, values: descriptorOf(descriptor.values) }, input, path);
  const handler = handlers[descriptor.type];
  if (handler === undefined) throw new SchemaError(path, `uses unsupported kind "${descriptor.type}"`);
  return handler(descriptor, input, path);
}

/**
 * The Schemastery brand the Host's config projector looks for. It is read with
 * `Reflect.get(value, Symbol.for('schemastery'))`, so a plugin can satisfy it
 * without importing `@deepseek-ai/schemastery` — which is not resolvable from a
 * profile package. Only a branded schema is reported as `status: "schema"`, and
 * only then does the Host serve this row a configuration namespace for the
 * Plugins-sidebar page to read and write.
 */
const kSchema = Symbol.for('schemastery');

/** The native node types the Host's projector dispatches on. */
const NATIVE_TYPE = {
  object: 'object',
  array: 'array',
  tuple: 'tuple',
  union: 'union',
  record: 'dict',
  nullable: 'union',
  string: 'string',
  number: 'number',
  integer: 'number',
  boolean: 'boolean',
  any: 'any',
  null: 'const',
};

/**
 * A brand-only constant node, used for enum members and a nullable's null branch.
 * @param value - the constant.
 * @returns a node the projector's `const` case accepts.
 */
function constNode(value) {
  return { [kSchema]: true, type: 'const', value, meta: { required: true } };
}

/** One chainable schema value. */
class SchemaValue {
  /**
   * Dynamic by design.
   *
   * This toolkit implements the Host's native-schema brand by hand (schemastery is not
   * resolvable from a profile directory), so one node carries whatever members a given kind
   * needs. The index signature states that honestly instead of pretending to a closed shape;
   * `docs/authoring.md` records the members the Host actually reads.
   */
  [key: string]: any;
  /**
   * @param descriptor - the descriptor this value validates with.
   */
  constructor(descriptor) {
    this.descriptor = descriptor;
    this.defaultValue = undefined;
    this.optionalFlag = false;
    this.volatileFlag = false;
    this.description = undefined;
    const schema = this;
    // Own enumerable property: survives any namespace copy of the exports.
    this['~standard'] = {
      version: 1,
      vendor: 'dsh-session-metrics',
      validate: (value) => {
        try {
          return { value: schema.parse(value) };
        } catch (error) {
          return {
            issues: [{
              message: error instanceof Error ? error.message : String(error),
              path: error && error.path ? [error.path] : undefined,
            }],
          };
        }
      },
    };

    // A native Schemastery graph, declared by duck-typed brand. These are own
    // enumerable accessors on purpose: own so a namespace copy keeps them, and
    // accessors so they still reflect chaining that happens after construction
    // (`.min()`, `.withDefault()`, `.optional()`, ...).
    Object.defineProperty(this, kSchema, { value: true, enumerable: true, configurable: true, writable: true });
    const native = (property, read) => {
      Object.defineProperty(this, property, { get: read, enumerable: true, configurable: true });
    };
    native('type', () => this.nativeType());
    native('meta', () => this.nativeMeta());
    native('value', () => (this.descriptor.type === 'null' ? null : undefined));
    native('dict', () => (this.descriptor.type === 'object' ? this.descriptor.shape : undefined));
    native('inner', () => {
      const kind = this.descriptor.type;
      if (kind === 'array') return this.descriptor.item;
      if (kind === 'record') return this.descriptor.values;
      return undefined;
    });
    native('list', () => {
      const kind = this.descriptor.type;
      if (kind === 'tuple') return this.descriptor.items;
      if (kind === 'union') return this.descriptor.options;
      if (kind === 'nullable') return [this.descriptor.inner, constNode(null)];
      if (kind === 'string' && this.descriptor.enum !== undefined) return this.descriptor.enum.map(constNode);
      return undefined;
    });
  }

  /** The native node type the Host's config projector dispatches on. */
  nativeType() {
    const kind = this.descriptor.type;
    if (kind === 'string' && this.descriptor.enum !== undefined) return 'union';
    if (kind === 'null') return 'const';
    return NATIVE_TYPE[kind] ?? 'any';
  }

  /**
   * The native `meta` object. `exclusiveMin`/`exclusiveMax` are projected as
   * inclusive bounds because the projector's vocabulary has no exclusive form;
   * the plugin's own validator still enforces the exclusive constraint.
   * @returns the metadata the projector reads.
   */
  nativeMeta() {
    const meta: Record<string, any> = { required: !this.optionalFlag };
    if (this.volatileFlag) meta.volatile = true;
    if (this.defaultValue !== undefined) meta.default = this.defaultValue;
    if (this.description !== undefined) meta.description = this.description;
    if (this.descriptor.min !== undefined) meta.min = this.descriptor.min;
    if (this.descriptor.exclusiveMin !== undefined) meta.min = this.descriptor.exclusiveMin;
    if (this.descriptor.max !== undefined) meta.max = this.descriptor.max;
    if (this.descriptor.exclusiveMax !== undefined) meta.max = this.descriptor.exclusiveMax;
    return meta;
  }

  /**
   * Mark the field user-editable in the harness Settings forms.
   *
   * Only fields at a **fixed object path** may be volatile: the Host's projector
   * throws `volatile fields require a fixed object path without an enclosing
   * volatile field` for one nested under an array, union or another volatile field.
   * So this belongs on a top-level object field, never on a rate row inside a
   * provider list.
   */
  volatile() {
    this.volatileFlag = true;
    return this;
  }

  /** Mark the field optional in its parent object. */
  optional() {
    this.optionalFlag = true;
    return this;
  }

  /** Require an integer value. */
  int() {
    this.descriptor = { ...this.descriptor, type: 'integer' };
    return this;
  }

  /** Require a value greater than zero. */
  positive() {
    this.descriptor = { ...this.descriptor, exclusiveMin: 0 };
    return this;
  }

  /**
   * Require at least this value.
   * @param value - inclusive minimum.
   */
  min(value) {
    this.descriptor = { ...this.descriptor, min: value };
    return this;
  }

  /**
   * Require at most this value.
   * @param value - inclusive maximum.
   */
  max(value) {
    this.descriptor = { ...this.descriptor, max: value };
    return this;
  }

  /**
   * Register a default applied when the field is absent.
   * @param value - the default, or a factory for a fresh one.
   */
  withDefault(value) {
    this.defaultValue = value;
    return this;
  }

  /**
   * Attach a description used by generated forms.
   * @param text - the field description.
   */
  describe(text) {
    this.description = text;
    return this;
  }

  /** The descriptor as consumed by parsing and JSON Schema generation. */
  get shape() {
    const kind = this.descriptor.type;
    const descriptor = kind === 'object'
      ? {
          ...this.descriptor,
          shape: Object.fromEntries(Object.entries(this.descriptor.shape).map(([key, child]) => [key, descriptorOf(child)])),
        }
      : kind === 'array'
        ? { ...this.descriptor, item: descriptorOf(this.descriptor.item) }
        : kind === 'tuple'
          ? { ...this.descriptor, items: this.descriptor.items.map(descriptorOf) }
          : kind === 'union'
            ? { ...this.descriptor, options: this.descriptor.options.map(descriptorOf) }
            : kind === 'nullable'
              ? { ...this.descriptor, inner: descriptorOf(this.descriptor.inner) }
              : this.descriptor;
    return {
      ...descriptor,
      ...(this.defaultValue === undefined ? {} : { default: this.defaultValue }),
      ...(this.optionalFlag ? { optional: true } : {}),
      ...(this.description === undefined ? {} : { description: this.description }),
    };
  }

  /**
   * Validate and fill one value.
   * @param value - the raw input.
   * @returns the resolved value.
   */
  parse(value) {
    return parseWith(this.shape, value, '');
  }

  /**
   * Validate without throwing.
   * @param value - the raw input.
   * @returns `{ success: true, data }` or `{ success: false, error }`.
   */
  safeParse(value) {
    try {
      return { success: true, data: this.parse(value) };
    } catch (error) {
      return { success: false, error };
    }
  }

  /**
   * The JSON Schema for this value, in the shape generated forms consume.
   * @returns a JSON Schema fragment.
   */
  toJSON() {
    const kind = this.descriptor.type === 'object'
      ? { type: 'object', shape: Object.fromEntries(Object.entries(this.descriptor.shape).map(([key, child]: [string, any]) => [key, child.toJSON()])) }
      : this.descriptor.type === 'array'
        ? { type: 'array', item: this.descriptor.item.toJSON() }
        : this.descriptor.type === 'union'
          ? { type: 'union', options: this.descriptor.options.map((option) => option.toJSON()) }
          : this.descriptor.type === 'tuple'
            ? { type: 'tuple', items: this.descriptor.items.map((item) => item.toJSON()) }
            : this.descriptor.type === 'nullable'
              ? { type: 'union', options: [this.descriptor.inner.toJSON(), { type: 'null' }] }
              : this.descriptor;
    return jsonOf(kind, { description: this.description });
  }
}

/** Build a schema value from a raw descriptor. */
const make = (descriptor) => new SchemaValue(descriptor);

/** Schema constructors mirroring the small `zod` surface this plugin needs. */
export const z = {
  string: () => make({ type: 'string' }),
  number: () => make({ type: 'number' }),
  int: () => make({ type: 'integer' }),
  integer: () => make({ type: 'integer' }),
  boolean: () => make({ type: 'boolean' }),
  any: () => make({ type: 'any' }),
  null: () => make({ type: 'null' }),
  literal: (value) => make({ type: 'string', enum: [value] }),
  enum: (values) => make({ type: 'string', enum: [...values] }),
  /**
   * @param shape - field name to schema value.
   * @param options - `strict: false` accepts unknown keys.
   */
  object: (shape: Record<string, any> = {}, options: Record<string, any> = {}) => make({ type: 'object', shape, strict: options.strict }),
  array: (item) => make({ type: 'array', item }),
  record: (values) => make({ type: 'record', values }),
  tuple: (items) => make({ type: 'tuple', items }),
  union: (options) => make({ type: 'union', options }),
  nullable: (inner) => make({ type: 'nullable', inner }),
};
