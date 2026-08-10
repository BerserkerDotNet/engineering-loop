/**
 * Strict JSON Schema subset validator (Node built-ins only).
 *
 * Only the keywords listed in SUPPORTED are honoured. Any other keyword in a
 * loaded schema throws at registry-build time, so a schema can never silently
 * validate less than it appears to.
 */

const SUPPORTED = new Set([
  "$schema", "$id", "$defs", "title", "description", "$ref",
  "type", "const", "enum", "properties", "required", "additionalProperties",
  "items", "minItems", "maxItems", "minimum", "maximum",
  "minLength", "maxLength", "pattern", "format", "anyOf",
]);

const ISO_DATE_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

export class SchemaError extends Error {}

/**
 * Walks a schema document rejecting any keyword outside SUPPORTED.
 *
 * `schemaMaps` names pointers whose value is a *map of schemas* rather than a
 * schema (event.schema.json#/$defs/data holds one payload schema per event
 * type). Those containers are listed explicitly instead of being guessed, so
 * an accidental keyword typo is still a hard error everywhere else.
 */
function assertSupported(node, where, schemaMaps) {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return;

  if (schemaMaps.has(where)) {
    for (const [k, v] of Object.entries(node)) {
      if (v === null || typeof v !== "object" || Array.isArray(v)) {
        throw new SchemaError(`schema map entry "${k}" at ${where} is not a schema object`);
      }
      assertSupported(v, `${where}/${k}`, schemaMaps);
    }
    return;
  }

  for (const key of Object.keys(node)) {
    if (!SUPPORTED.has(key)) {
      throw new SchemaError(`unsupported schema keyword "${key}" at ${where}`);
    }
  }
  if (node.$defs) {
    for (const [k, v] of Object.entries(node.$defs)) assertSupported(v, `${where}/$defs/${k}`, schemaMaps);
  }
  if (node.properties) {
    for (const [k, v] of Object.entries(node.properties)) assertSupported(v, `${where}/properties/${k}`, schemaMaps);
  }
  if (node.items) assertSupported(node.items, `${where}/items`, schemaMaps);
  if (Array.isArray(node.anyOf)) node.anyOf.forEach((v, i) => assertSupported(v, `${where}/anyOf/${i}`, schemaMaps));
  if (node.additionalProperties !== undefined && typeof node.additionalProperties !== "boolean") {
    throw new SchemaError(`additionalProperties must be boolean at ${where}`);
  }
}

/**
 * Builds a resolver over a set of named schema documents.
 * Cross-document refs use "<docName>#/pointer"; local refs use "#/pointer".
 *
 * @param {Record<string, object>} documents
 * @param {{schemaMaps?: string[]}} [options] pointers ("<doc>#/$defs/data") whose
 *   value is a map of schemas keyed by name rather than a single schema.
 */
export function createRegistry(documents, options = {}) {
  const schemaMaps = new Set();
  for (const pointer of options.schemaMaps || []) {
    const hash = pointer.indexOf("#");
    if (hash < 0) throw new SchemaError(`schemaMaps entry "${pointer}" must be a "<doc>#/pointer" reference`);
    const docName = pointer.slice(0, hash);
    if (!documents[docName]) throw new SchemaError(`schemaMaps entry "${pointer}" names unknown document`);
    schemaMaps.add(docName + pointer.slice(hash + 1));
  }

  for (const [name, doc] of Object.entries(documents)) {
    assertSupported(doc, name, schemaMaps);
  }

  function resolve(ref, currentDoc) {
    const hash = ref.indexOf("#");
    if (hash < 0) throw new SchemaError(`unresolvable $ref "${ref}"`);
    const docName = ref.slice(0, hash);
    const pointer = ref.slice(hash + 1);
    const doc = docName ? documents[docName] : currentDoc;
    if (!doc) throw new SchemaError(`unknown schema document "${docName}"`);
    if (!pointer || pointer === "/") return { schema: doc, doc };
    let node = doc;
    for (const rawPart of pointer.split("/").slice(1)) {
      const part = rawPart.replace(/~1/g, "/").replace(/~0/g, "~");
      node = node?.[part];
      if (node === undefined) throw new SchemaError(`unresolvable $ref "${ref}"`);
    }
    return { schema: node, doc };
  }

  function check(schema, doc, value, path, errors) {
    if (schema.$ref) {
      const target = resolve(schema.$ref, doc);
      check(target.schema, target.doc, value, path, errors);
      return;
    }

    if (schema.anyOf) {
      for (const branch of schema.anyOf) {
        const sub = [];
        check(branch, doc, value, path, sub);
        if (sub.length === 0) return;
      }
      errors.push({ path, message: "did not match any allowed variant" });
      return;
    }

    if (schema.const !== undefined && value !== schema.const) {
      errors.push({ path, message: `expected constant ${JSON.stringify(schema.const)}` });
      return;
    }

    if (schema.enum && !schema.enum.includes(value)) {
      errors.push({ path, message: `expected one of ${JSON.stringify(schema.enum)}` });
      return;
    }

    if (schema.type) {
      const actual = value === null
        ? "null"
        : Array.isArray(value) ? "array"
        : typeof value === "number"
          ? (Number.isInteger(value) ? "integer" : "number")
          : typeof value;
      // JSON Schema allows a union of permitted types. A nullable field is the
      // common case here, and treating the union as an opaque string would
      // reject every value it is supposed to allow.
      const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
      const accepts = (expected) => expected === "integer"
        ? actual === "integer"
        : expected === "number"
          ? (actual === "number" || actual === "integer")
          : actual === expected;
      if (!allowed.some(accepts)) {
        errors.push({ path, message: `expected type ${allowed.join(",")}, received ${actual}` });
        return;
      }
    }

    if (typeof value === "string") {
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        errors.push({ path, message: `shorter than minLength ${schema.minLength}` });
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        errors.push({ path, message: `longer than maxLength ${schema.maxLength}` });
      }
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
        errors.push({ path, message: `does not match pattern ${schema.pattern}` });
      }
      if (schema.format === "date-time" && !ISO_DATE_TIME.test(value)) {
        errors.push({ path, message: "is not an ISO-8601 date-time" });
      }
    }

    if (typeof value === "number") {
      if (schema.minimum !== undefined && value < schema.minimum) {
        errors.push({ path, message: `below minimum ${schema.minimum}` });
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        errors.push({ path, message: `above maximum ${schema.maximum}` });
      }
    }

    if (Array.isArray(value)) {
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        errors.push({ path, message: `fewer than minItems ${schema.minItems}` });
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        errors.push({ path, message: `more than maxItems ${schema.maxItems}` });
      }
      if (schema.items) {
        value.forEach((item, i) => check(schema.items, doc, item, `${path}[${i}]`, errors));
      }
    }

    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const key of schema.required || []) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
          errors.push({ path: `${path}.${key}`, message: "is required" });
        }
      }
      const props = schema.properties || {};
      for (const [key, sub] of Object.entries(value)) {
        if (props[key]) {
          check(props[key], doc, sub, `${path}.${key}`, errors);
        } else if (schema.additionalProperties === false && schema.properties) {
          errors.push({ path: `${path}.${key}`, message: "is not an allowed property" });
        }
      }
    }
  }

  return {
    documents,
    /** @returns {{ok: boolean, errors: {path: string, message: string}[]}} */
    validate(ref, value) {
      const errors = [];
      try {
        const target = resolve(ref, null);
        check(target.schema, target.doc, value, "$", errors);
      } catch (error) {
        errors.push({ path: "$", message: error.message });
      }
      return { ok: errors.length === 0, errors };
    },
    has(ref) {
      try {
        resolve(ref, null);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function formatErrors(errors) {
  return errors.map((e) => `${e.path} ${e.message}`).join("; ");
}
