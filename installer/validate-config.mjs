#!/usr/bin/env node
/*
 * WrexrOS unattended configuration validator.
 *
 * Dependency-free validator for the JSON Schema subset used by
 * installer/unattended.schema.json:
 *   type, required, enum, const, minimum/maximum, minLength/maxLength,
 *   minItems/maxItems, pattern, items, properties, additionalProperties,
 *   oneOf/anyOf/allOf, default injection.
 * Three documented extensions are also understood:
 *   contains                        -> array must have a matching item
 *   uniqueItemProperties: ["path"]  -> unique values of a property in an array
 *   sensitive: true                 -> password field; config file must be 0600
 *
 * Usage:
 *   node validate-config.mjs CONFIG [--schema SCHEMA] [--output FILE]
 *                           [--print-defaults] [--no-perm-check] [--quiet]
 * Exit: 0 = valid, 1 = invalid / usage / IO error.
 */

import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCHEMA = resolve(HERE, "unattended.schema.json");

function fail(message) {
  process.stderr.write(`validate-config: error: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = {
    file: null,
    schema: DEFAULT_SCHEMA,
    output: null,
    printDefaults: false,
    noPermCheck: false,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--help":
      case "-h":
        process.stdout.write(
          "Usage: validate-config.mjs CONFIG [--schema FILE] [--output FILE]\n" +
            "                              [--print-defaults] [--no-perm-check] [--quiet]\n",
        );
        process.exit(0);
        break;
      case "--schema":
      case "--output":
        i += 1;
        if (i >= argv.length) fail(`${arg} needs a path`);
        opts[arg === "--schema" ? "schema" : "output"] = resolve(argv[i]);
        break;
      case "--print-defaults":
        opts.printDefaults = true;
        break;
      case "--no-perm-check":
        opts.noPermCheck = true;
        break;
      case "--quiet":
        opts.quiet = true;
        break;
      default:
        if (arg.startsWith("-")) fail(`unknown option: ${arg}`);
        if (opts.file !== null) fail("only one CONFIG file may be given");
        opts.file = resolve(arg);
    }
  }
  if (opts.file === null) fail("missing CONFIG file (use --help)");
  return opts;
}

function typeOK(value, type) {
  switch (type) {
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}

function typename(type) {
  return Array.isArray(type) ? type.join(" | ") : String(type);
}

function pointer(path) {
  return path === "$" ? "$" : path;
}

function short(value) {
  const text = JSON.stringify(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/** Inject schema defaults before validation, so oneOf branches see defaults. */
function applyDefaults(value, schema, path = "$") {
  if (!schema || typeof schema !== "object") return;
  if (typeOK(value, "object") && schema.properties) {
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (value[key] === undefined && Object.prototype.hasOwnProperty.call(sub, "default")) {
        value[key] = structuredClone(sub.default);
      }
    }
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (value[key] !== undefined) applyDefaults(value[key], sub, `${path}.${key}`);
    }
  }
  if (Array.isArray(value) && schema.items && typeof schema.items === "object") {
    value.forEach((item, index) => applyDefaults(item, schema.items, `${path}[${index}]`));
  }
}

function validate(value, schema, path, errors) {
  if (!schema || typeof schema === "boolean") return;

  if (schema.type !== undefined && !typeOK(value, schema.type)) {
    errors.push(`${pointer(path)}: expected type ${typename(schema.type)}, got ${typeOK(value, "null") ? "null" : typeof value}`);
    return;
  }
  if (schema.enum !== undefined && !schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) {
    errors.push(`${pointer(path)}: must be one of ${schema.enum.map(short).join(", ")} (got ${short(value)})`);
  }
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) {
    errors.push(`${pointer(path)}: must be ${short(schema.const)} (got ${short(value)})`);
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${pointer(path)}: string must be at least ${schema.minLength} characters long`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${pointer(path)}: string must be at most ${schema.maxLength} characters long`);
    }
    if (schema.pattern !== undefined) {
      let re;
      try {
        re = new RegExp(schema.pattern);
      } catch {
        fail(`invalid regular expression in schema at ${pointer(path)}: ${schema.pattern}`);
      }
      if (!re.test(value)) errors.push(`${pointer(path)}: value ${short(value)} does not match ${schema.pattern}`);
    }
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${pointer(path)}: must be >= ${schema.minimum} (got ${value})`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${pointer(path)}: must be <= ${schema.maximum} (got ${value})`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${pointer(path)}: array must contain at least ${schema.minItems} item(s)`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${pointer(path)}: array must contain at most ${schema.maxItems} item(s)`);
    }
    if (schema.uniqueItemProperties) {
      for (const prop of schema.uniqueItemProperties) {
        const seen = new Map();
        value.forEach((item, index) => {
          if (!typeOK(item, "object") || item[prop] === undefined) return;
          const key = String(item[prop]);
          if (seen.has(key)) {
            errors.push(`${pointer(path)}[${index}].${prop}: duplicate value ${short(key)} (already used at index ${seen.get(key)})`);
          } else {
            seen.set(key, index);
          }
        });
      }
    }
    if (schema.items && typeof schema.items === "object") {
      value.forEach((item, index) => validate(item, schema.items, `${path}[${index}]`, errors));
    }
    if (schema.contains && typeof schema.contains === "object") {
      const found = value.some((item) => {
        const branchErrors = [];
        validate(item, schema.contains, path, branchErrors);
        return branchErrors.length === 0;
      });
      if (!found) errors.push(`${pointer(path)}: must contain at least one item matching ${schema.contains.title || "the required shape"}`);
    }
  }

  if (typeOK(value, "object")) {
    for (const key of schema.required || []) {
      if (value[key] === undefined) errors.push(`${pointer(path)}: missing required property "${key}"`);
    }
    const props = schema.properties || {};
    for (const [key, sub] of Object.entries(props)) {
      if (value[key] !== undefined) validate(value[key], sub, `${path}.${key}`, errors);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) errors.push(`${pointer(path)}: unknown property "${key}" (not allowed by schema)`);
      }
    } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
      for (const key of Object.keys(value)) {
        if (!(key in props)) validate(value[key], schema.additionalProperties, `${path}.${key}`, errors);
      }
    }
  }

  const branches = [];
  if (schema.anyOf) branches.push(["anyOf", schema.anyOf, false, false]);
  if (schema.oneOf) branches.push(["oneOf", schema.oneOf, false, true]);
  if (schema.allOf) branches.push(["allOf", schema.allOf, true, false]);
  for (const [keyword, list, requireAll, exactlyOne] of branches) {
    const passes = list.map((sub) => {
      const branchErrors = [];
      validate(value, sub, path, branchErrors);
      return branchErrors.length === 0;
    });
    const count = passes.filter(Boolean).length;
    if (requireAll && count !== list.length) {
      errors.push(`${pointer(path)}: all ${keyword} branches must validate (${count}/${list.length} passed)`);
    } else if (!requireAll && exactlyOne && count !== 1) {
      errors.push(`${pointer(path)}: exactly one ${keyword} branch must validate (${count} matched)`);
    } else if (!requireAll && !exactlyOne && count === 0) {
      errors.push(`${pointer(path)}: at least one ${keyword} branch must validate`);
    }
  }
}

/** Locate sensitive values declared with the "sensitive" extension. */
function findSensitive(value, schema, path, found) {
  if (!schema || typeof schema !== "object") return;
  if (schema.sensitive === true && value !== undefined) found.push(path);
  if (typeOK(value, "object")) {
    for (const [key, sub] of Object.entries(schema.properties || {})) {
      if (value[key] !== undefined) findSensitive(value[key], sub, `${path}.${key}`, found);
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => findSensitive(item, schema.items, `${path}[${index}]`, found));
  }
  for (const sub of [...(schema.oneOf || []), ...(schema.anyOf || []), ...(schema.allOf || [])]) {
    findSensitive(value, sub, path, found);
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  let raw;
  let schema;
  try {
    raw = readFileSync(opts.file, "utf8");
    schema = JSON.parse(readFileSync(opts.schema, "utf8"));
  } catch (error) {
    fail(`cannot read input: ${error.message}`);
  }

  let data;
  try {
    data = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (error) {
    fail(`${opts.file}: invalid JSON: ${error.message}`);
  }

  applyDefaults(data, schema);

  const errors = [];
  validate(data, schema, "$", errors);

  if (!opts.noPermCheck) {
    const sensitive = [];
    findSensitive(data, schema, "$", sensitive);
    if (sensitive.length > 0) {
      const mode = statSync(opts.file).mode & 0o777;
      if ((mode & 0o077) !== 0) {
        errors.push(`${opts.file}: mode ${mode.toString(8)} is group/world-readable; passwords at ${sensitive.join(", ")} require chmod 600 (or use --no-perm-check for CI fixtures)`);
      }
    }
  }

  if (errors.length > 0) {
    process.stderr.write(`validate-config: ${errors.length} error(s) in ${opts.file}:\n`);
    for (const error of errors) process.stderr.write(`  - ${error}\n`);
    process.exit(1);
  }

  const json = `${JSON.stringify(data, null, 2)}\n`;
  if (opts.output) {
    try {
      writeFileSync(opts.output, json, { mode: 0o600 });
      chmodSync(opts.output, 0o600);
    } catch (error) {
      fail(`cannot write ${opts.output}: ${error.message}`);
    }
  }
  if (opts.printDefaults || !opts.quiet) {
    process.stdout.write(`${opts.file}: valid\n`);
  }
  if (opts.printDefaults) process.stdout.write(json);
}

main();
