#!/usr/bin/env node
/**
 * Checks the TypeScript samples in the docs against the public API in src/.
 *
 * The docs are never compiled, so a renamed method, a removed option key or an
 * export moved to another entry point leaves every sample that uses it stale
 * without failing anything. This script reads the API from src/ with the
 * TypeScript compiler and checks what the samples name:
 *
 *   - imports from "@stingerloom/orm" and its subpaths name a real export of
 *     that entry point;
 *   - calls on an EntityManager, a repository and the objects they return name
 *     a public member and pass an argument count one of its signatures takes,
 *     and property reads on ORM types name a real property;
 *   - object literals passed to ORM methods, functions, constructors and
 *     decorators use keys the parameter type declares, and an object is not
 *     passed where the parameter takes a function, or the other way round;
 *     a string the key's type spells out (`type: "postgres"`) is one it lists;
 *   - `new` names a class that is not abstract and has a public constructor;
 *   - an `interface` restating an exported type declares only properties
 *     the type has;
 *   - the method tables of api-reference.md name real members with the
 *     required parameters the source declares, its `Export` tables name real
 *     exports, and decorator rows (`@Name(a, b?)`) in any table match the
 *     decorator's parameters.
 *
 * A sample the checker cannot type (an unknown receiver, a generic parameter)
 * is skipped, so the script reports mismatches, not missing coverage. Put
 * `<!-- check-docs-api: skip -->` on the line above a fence to leave out a
 * sample that is wrong on purpose.
 *
 * Usage: node scripts/check-docs-api.js [file.md ...]   (part of pnpm docs:check)
 */

const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const ROOT = path.resolve(__dirname, "..");
const DOCS = path.join(ROOT, "docs");
const SRC = path.join(ROOT, "src") + path.sep;
const PKG = "@stingerloom/orm";
const SKIP_MARKER = "<!-- check-docs-api: skip -->";
const CODE_LANGS = new Set(["ts", "typescript", "js", "javascript", "tsx", "mts"]);

// ── The API, as src/ declares it ───────────────────────────────────────

/** "@stingerloom/orm/nestjs" -> src/integration/nestjs/index.ts, from package.json exports. */
function entryFiles() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
  const entries = new Map();
  for (const [subpath, target] of Object.entries(pkg.exports)) {
    const types = typeof target === "string" ? target : target.types;
    if (!types) continue;
    const file = path.join(ROOT, types.replace(/^\.\/dist\//, "src/").replace(/\.d\.ts$/, ".ts"));
    entries.set(subpath === "." ? PKG : `${PKG}${subpath.slice(1)}`, file);
  }
  return entries;
}

const ENTRIES = entryFiles();
const config = ts.readConfigFile(path.join(ROOT, "tsconfig.json"), ts.sys.readFile);
const compilerOptions = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT).options;
const program = ts.createProgram({
  rootNames: [...ENTRIES.values()],
  options: { ...compilerOptions, noEmit: true },
});
const checker = program.getTypeChecker();

const resolveAlias = (symbol) =>
  symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;

/** Entry point specifier -> (export name -> symbol). */
const EXPORTS = new Map();
for (const [specifier, file] of ENTRIES) {
  const sourceFile = program.getSourceFile(file);
  const moduleSymbol = sourceFile && checker.getSymbolAtLocation(sourceFile);
  const names = new Map();
  if (moduleSymbol) {
    for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
      names.set(symbol.getName(), resolveAlias(symbol));
    }
  }
  EXPORTS.set(specifier, names);
}
const ROOT_EXPORTS = EXPORTS.get(PKG);

function entriesExporting(name) {
  return [...EXPORTS].filter(([, names]) => names.has(name)).map(([spec]) => spec);
}

/** A name a sample uses without importing it: the root export, else any entry's. */
function exportedSymbol(name) {
  if (ROOT_EXPORTS.has(name)) return ROOT_EXPORTS.get(name);
  for (const names of EXPORTS.values()) if (names.has(name)) return names.get(name);
  return undefined;
}

function declaredInSrc(symbol) {
  return !!symbol?.declarations?.some((d) => d.getSourceFile().fileName.startsWith(SRC));
}

/** The instance type of an exported class or interface. */
function declaredType(name) {
  const symbol = exportedSymbol(name);
  if (!symbol || !(symbol.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Interface))) return undefined;
  return checker.getDeclaredTypeOfSymbol(symbol);
}

const ENTITY_MANAGER = declaredType("EntityManager");
const REPOSITORY = declaredType("BaseRepository");

/** Methods plugins add to an EntityManager (`em.pipe`, `em.buffer`). */
const PLUGIN_MEMBERS = new Map();
for (const names of EXPORTS.values()) {
  for (const symbol of names.values()) {
    if (!(symbol.flags & ts.SymbolFlags.Function) || !symbol.valueDeclaration) continue;
    const type = checker.getTypeOfSymbolAtLocation(symbol, symbol.valueDeclaration);
    for (const signature of type.getCallSignatures()) {
      const returned = checker.getReturnTypeOfSignature(signature);
      if (returned.getSymbol()?.getName() !== "StingerloomPlugin") continue;
      const [api] = checker.getTypeArguments(returned);
      for (const member of api ? checker.getPropertiesOfType(api) : []) {
        PLUGIN_MEMBERS.set(member.getName(), member);
      }
    }
  }
}

function isPublic(symbol) {
  const decl = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (!decl) return true;
  if (decl.name && ts.isPrivateIdentifier(decl.name)) return false;
  return !(ts.getCombinedModifierFlags(decl) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected));
}

/** A public member of an ORM type, including plugin methods on an EntityManager. */
function memberOf(type, name) {
  const symbol = checker.getPropertyOfType(type, name);
  if (symbol && isPublic(symbol)) return symbol;
  if (type === ENTITY_MANAGER && PLUGIN_MEMBERS.has(name)) return PLUGIN_MEMBERS.get(name);
  return undefined;
}

function typeOfSymbol(symbol) {
  const decl = symbol.valueDeclaration ?? symbol.declarations?.[0];
  return decl ? checker.getTypeOfSymbolAtLocation(symbol, decl) : checker.getTypeOfSymbol(symbol);
}

function callSignatures(symbol) {
  return typeOfSymbol(symbol).getCallSignatures();
}

function constructSignatures(classSymbol) {
  return typeOfSymbol(classSymbol).getConstructSignatures();
}

/** Required and maximum argument counts of a signature. */
function arity(signature) {
  let min = 0;
  let max = 0;
  for (const param of signature.getParameters()) {
    const decl = param.valueDeclaration;
    if (decl && ts.isParameter(decl) && decl.dotDotDotToken) return { min, max: Infinity };
    max++;
    if (!(decl && ts.isParameter(decl) && (decl.questionToken || decl.initializer))) min = max;
  }
  return { min, max };
}

function describeArity(signatures) {
  const ranges = [...new Set(signatures.map((s) => {
    const { min, max } = arity(s);
    if (max === Infinity) return `${min}+`;
    return min === max ? `${min}` : `${min}-${max}`;
  }))];
  return ranges.join(" or ");
}

/** An ORM-declared object type whose property names are known. */
function checkable(type) {
  if (!type) return false;
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter | ts.TypeFlags.Never)) {
    return false;
  }
  if (type.isUnionOrIntersection()) return false;
  if (!declaredInSrc(type.getSymbol() ?? type.aliasSymbol)) return false;
  return checker.getIndexInfosOfType(type).length === 0;
}

function typeName(type) {
  return (type.aliasSymbol ?? type.getSymbol())?.getName() ?? checker.typeToString(type);
}

/**
 * The string values a property accepts when its type is a union of string
 * literals (`type: "mysql" | "postgres" | ...`), or null when it takes others.
 */
function literalValues(props) {
  const values = new Set();
  for (const prop of props) {
    const type = checker.getNonNullableType(typeOfSymbol(prop));
    for (const part of type.isUnion() ? type.types : [type]) {
      if (!part.isStringLiteral()) return null;
      values.add(part.value);
    }
  }
  return values.size ? values : null;
}

/**
 * The keys an object literal may use for a parameter, or null when they are
 * not knowable (a generic parameter, an index signature). `expected` is set
 * instead when the parameter takes no object at all.
 */
function allowedKeys(paramTypes) {
  const keys = new Map();
  let objectParts = 0;
  let functionParts = 0;
  let primitiveParts = 0;
  const visit = (type) => {
    if (type.isUnion()) return type.types.every(visit);
    if (type.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)) return true;
    if (type.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike
      | ts.TypeFlags.BigIntLike | ts.TypeFlags.ESSymbolLike)) {
      primitiveParts++;
      return true;
    }
    if (!(type.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection))) return false;
    // A mapped type over a generic parameter (`{ [K in keyof T]?: ... }`) has
    // no properties until T is known, so its keys cannot be checked.
    const parts = type.isIntersection() ? type.types : [type];
    if (parts.some((t) => !(t.flags & ts.TypeFlags.Object) || t.objectFlags & ts.ObjectFlags.Mapped)) return false;
    if (checker.getIndexInfosOfType(type).length) return false;
    const props = checker.getPropertiesOfType(type);
    if (props.length === 0) {
      if (type.getCallSignatures().length) {
        functionParts++;
        return true;
      }
      return false;
    }
    objectParts++;
    for (const prop of props) keys.set(prop.getName(), [...(keys.get(prop.getName()) ?? []), prop]);
    return true;
  };
  for (const type of paramTypes) {
    if (!visit(checker.getNonNullableType(type))) return null;
  }
  if (objectParts > 0) return { keys, takesFunction: functionParts > 0 };
  if (functionParts > 0) return { expected: "a function" };
  if (primitiveParts > 0) return { expected: "a value, not an options object" };
  return null;
}

// ── Markdown ───────────────────────────────────────────────────────────

function markdownFiles() {
  const out = [];
  for (const dir of [DOCS, path.join(DOCS, "ko")]) {
    for (const name of fs.readdirSync(dir).sort()) {
      if (name.endsWith(".md")) out.push(path.join(dir, name));
    }
  }
  out.push(path.join(ROOT, "README.md"));
  return out;
}

/** Fenced TypeScript/JavaScript blocks with the line their code starts on. */
function codeBlocks(lines) {
  const blocks = [];
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!open) {
      const m = /^(\s*)(`{3,}|~{3,})\s*([\w-]*)/.exec(line);
      if (!m) continue;
      let prev = i - 1;
      while (prev >= 0 && lines[prev].trim() === "") prev--;
      open = {
        indent: m[1].length,
        fence: m[2],
        lang: m[3].toLowerCase(),
        start: i + 2,
        skip: prev >= 0 && lines[prev].trim() === SKIP_MARKER,
        body: [],
      };
      continue;
    }
    if (line.trim().startsWith(open.fence) && line.trim().replace(/[`~]/g, "") === "") {
      if (CODE_LANGS.has(open.lang) && !open.skip) {
        blocks.push({ start: open.start, code: open.body.map((l) => l.slice(Math.min(open.indent, l.search(/\S|$/)))).join("\n") });
      }
      open = null;
      continue;
    }
    open.body.push(line);
  }
  return blocks;
}

// ── Samples ────────────────────────────────────────────────────────────

const DEFAULT_RECEIVERS = [
  [/^(em|entityManager|manager|[a-z]\w*Em)$/, () => ENTITY_MANAGER],
  [/^(repo|repository|[a-z]\w*Repo)$/, () => REPOSITORY],
];

/**
 * `scope` carries a page's imports, and the variables it declares with `new`
 * or a type annotation, from one sample to the next, as a reader does:
 * `const em = new MultiTenantEntityManager()` in one block types `em` in the
 * blocks after it. A variable typed from a call's result (`const qb = ...`)
 * stays in its block, since pages reuse such names for different builders.
 */
function checkBlock(report, block, scope) {
  const source = ts.createSourceFile("sample.ts", block.code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  // A sample with `...` placeholders parses with errors; a call that holds one
  // has no argument count worth checking.
  const parseErrors = (source.parseDiagnostics ?? []).map((d) => d.start);
  const parsedCleanly = (node) => !parseErrors.some((at) => at >= node.pos && at < node.end);
  const lineOf = (node) => block.start + source.getLineAndCharacterOfPosition(node.getStart(source)).line;
  const { imported } = scope;
  /** Local name -> ORM type, or null when declared but not typeable. */
  const locals = new Map();
  const isLocal = (name) => locals.has(name) || scope.locals.has(name);
  /** The ORM type each checked call returns. */
  const callTypes = new WeakMap();
  /** Decorator calls, checked as decorators rather than as plain calls. */
  const decoratorCalls = new WeakSet();

  const symbolFor = (name) => (imported.has(name) ? imported.get(name) : exportedSymbol(name));

  const typeFromAnnotation = (node) => {
    if (!node || !ts.isTypeReferenceNode(node)) return undefined;
    const name = ts.isIdentifier(node.typeName) ? node.typeName.text : undefined;
    const symbol = name && symbolFor(name);
    if (!symbol || !(symbol.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Interface))) return undefined;
    return checker.getDeclaredTypeOfSymbol(symbol);
  };

  const named = (name) => {
    if (locals.has(name)) return locals.get(name) ?? undefined;
    if (scope.locals.has(name)) return scope.locals.get(name) ?? undefined;
    for (const [pattern, type] of DEFAULT_RECEIVERS) if (pattern.test(name)) return type();
    return undefined;
  };

  /** Signatures of `callee` that take `count` arguments. */
  const fitting = (signatures, count) =>
    signatures.filter((s) => {
      const { min, max } = arity(s);
      return count >= min && count <= max;
    });

  const checkArguments = (label, signatures, args, node) => {
    if (signatures.length === 0) return [];
    const spread = args.some((a) => ts.isSpreadElement(a));
    const matching = spread ? signatures : fitting(signatures, args.length);
    if (matching.length === 0) {
      if (parsedCleanly(node)) {
        report(lineOf(node), `${label} takes ${describeArity(signatures)} argument(s); the sample passes ${args.length}`);
      }
      return [];
    }
    if (spread) return matching;
    args.forEach((arg, index) => {
      const isFunction = ts.isArrowFunction(arg) || ts.isFunctionExpression(arg);
      if (!ts.isObjectLiteralExpression(arg) && !isFunction) return;
      const paramTypes = [];
      for (const signature of matching) {
        const param = signature.getParameters()[index];
        if (!param) return;
        const decl = param.valueDeclaration;
        if (decl && ts.isParameter(decl) && decl.dotDotDotToken) return;
        paramTypes.push(typeOfSymbol(param));
      }
      const allowed = allowedKeys(paramTypes);
      if (!allowed) return;
      if (isFunction) {
        if (allowed.keys && !allowed.takesFunction) {
          report(lineOf(arg), `argument ${index + 1} of ${label} takes an options object; the sample passes a function`);
        }
        return;
      }
      if (allowed.expected) {
        report(lineOf(arg), `argument ${index + 1} of ${label} takes ${allowed.expected}; the sample passes an object`);
        return;
      }
      for (const prop of arg.properties) {
        if (ts.isSpreadAssignment(prop)) continue;
        const key = prop.name && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) ? prop.name.text : undefined;
        if (key === undefined) continue;
        if (!allowed.keys.has(key)) {
          report(lineOf(prop), `'${key}' is not an option of argument ${index + 1} of ${label}`);
          continue;
        }
        const value = ts.isPropertyAssignment(prop) && prop.initializer;
        const values = value && ts.isStringLiteral(value) && literalValues(allowed.keys.get(key));
        if (values && !values.has(value.text)) {
          report(lineOf(value), `'${key}: "${value.text}"' is not accepted by ${label}; it takes ${[...values].map((v) => `"${v}"`).join(", ")}`);
        }
      }
    });
    return matching;
  };

  const returnOf = (signatures, receiver) => {
    if (signatures.length === 0) return undefined;
    const returned = checker.getReturnTypeOfSignature(signatures[0]);
    if (returned.flags & ts.TypeFlags.TypeParameter && returned.getSymbol()?.getName() === "this") return receiver;
    return returned;
  };

  /** The ORM type of an expression, when it can be followed. */
  const typeOf = (node) => {
    if (!node) return undefined;
    if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) return typeOf(node.expression);
    if (ts.isAsExpression(node)) return typeFromAnnotation(node.type) ?? typeOf(node.expression);
    if (ts.isAwaitExpression(node)) {
      const inner = typeOf(node.expression);
      return inner && checker.getAwaitedType(inner);
    }
    if (ts.isIdentifier(node)) {
      const type = named(node.text);
      if (type || isLocal(node.text)) return type;
      // `Conditions.fullTextSearch(...)`: the static side of an exported class.
      const symbol = symbolFor(node.text);
      return symbol && symbol.flags & ts.SymbolFlags.Class ? typeOfSymbol(symbol) : undefined;
    }
    if (ts.isPropertyAccessExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ThisKeyword) return named(node.name.text);
      const receiver = typeOf(node.expression);
      if (!checkable(receiver)) return undefined;
      const member = memberOf(receiver, node.name.text);
      return member && typeOfSymbol(member);
    }
    if (ts.isCallExpression(node)) return callTypes.get(node);
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      const symbol = symbolFor(node.expression.text);
      if (symbol && symbol.flags & ts.SymbolFlags.Class) return checker.getDeclaredTypeOfSymbol(symbol);
    }
    return undefined;
  };

  const visitCall = (node) => {
    const args = [...node.arguments];
    const callee = node.expression;
    if (ts.isPropertyAccessExpression(callee)) {
      const receiver = typeOf(callee.expression);
      if (!checkable(receiver)) return;
      const name = callee.name.text;
      const member = memberOf(receiver, name);
      if (!member) {
        report(lineOf(callee.name), `${typeName(receiver)}.${name}() does not exist`);
        return;
      }
      // A plugin the sample defines adds members this script cannot see.
      if (receiver === ENTITY_MANAGER && name === "extend" && ts.isIdentifier(callee.expression)) {
        const plugin = args[0];
        const known = plugin && ts.isCallExpression(plugin) && ts.isIdentifier(plugin.expression)
          && exportedSymbol(plugin.expression.text);
        if (!known) scope.locals.set(callee.expression.text, null);
      }
      const matching = checkArguments(`${typeName(receiver)}.${name}()`, callSignatures(member), args, node);
      callTypes.set(node, returnOf(matching, receiver));
      return;
    }
    if (ts.isIdentifier(callee) && !isLocal(callee.text)) {
      const symbol = symbolFor(callee.text);
      if (!symbol || !(symbol.flags & ts.SymbolFlags.Function) || !declaredInSrc(symbol)) return;
      const matching = checkArguments(`${callee.text}()`, callSignatures(symbol), args, node);
      callTypes.set(node, returnOf(matching));
    }
  };

  const visitNew = (node) => {
    if (!ts.isIdentifier(node.expression) || isLocal(node.expression.text)) return;
    const symbol = symbolFor(node.expression.text);
    if (!symbol || !(symbol.flags & ts.SymbolFlags.Class) || !declaredInSrc(symbol)) return;
    const decl = symbol.valueDeclaration;
    if (decl && ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Abstract) {
      report(lineOf(node), `${symbol.getName()} is abstract; the sample constructs it`);
      return;
    }
    const ctor = decl && ts.isClassDeclaration(decl) && decl.members.find(ts.isConstructorDeclaration);
    if (ctor && ts.getCombinedModifierFlags(ctor) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) {
      report(lineOf(node), `${symbol.getName()} has no public constructor; the sample constructs it`);
      return;
    }
    checkArguments(`new ${symbol.getName()}()`, constructSignatures(symbol), [...(node.arguments ?? [])], node);
  };

  const visitDecorator = (node) => {
    const call = node.expression;
    if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) return;
    const symbol = symbolFor(call.expression.text);
    if (!symbol || !(symbol.flags & ts.SymbolFlags.Function) || !declaredInSrc(symbol)) return;
    decoratorCalls.add(call);
    checkArguments(`@${call.expression.text}()`, callSignatures(symbol), [...call.arguments], call);
  };

  const visitImport = (node) => {
    const specifier = node.moduleSpecifier.text;
    if (specifier !== PKG && !specifier.startsWith(`${PKG}/`)) return;
    const names = EXPORTS.get(specifier);
    const bindings = node.importClause?.namedBindings;
    if (!names) {
      report(lineOf(node), `"${specifier}" is not an entry point of the package`);
      return;
    }
    if (!bindings || !ts.isNamedImports(bindings)) return;
    for (const element of bindings.elements) {
      const name = (element.propertyName ?? element.name).text;
      if (names.has(name)) {
        imported.set(element.name.text, names.get(name));
        continue;
      }
      const elsewhere = entriesExporting(name);
      report(
        lineOf(element),
        `${name} is not exported from "${specifier}"${elsewhere.length ? ` (it is exported from "${elsewhere[0]}")` : ""}`,
      );
    }
  };

  const declare = (name, type, durable) => {
    if (!ts.isIdentifier(name)) return;
    locals.set(name.text, type ?? null);
    if (durable && type) scope.locals.set(name.text, type);
  };

  /** `interface SchemaDiffResult { ... }` restating a type the package exports. */
  const visitInterface = (node) => {
    const symbol = ROOT_EXPORTS.get(node.name.text);
    if (!symbol || !(symbol.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias)) || !declaredInSrc(symbol)) return;
    const type = checker.getDeclaredTypeOfSymbol(symbol);
    if (checker.getIndexInfosOfType(type).length) return;
    const names = new Set(checker.getPropertiesOfType(type).map((p) => p.getName()));
    if (names.size === 0) return;
    for (const member of node.members) {
      const name = member.name && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) ? member.name.text : undefined;
      if (name !== undefined && !names.has(name)) report(lineOf(member), `${node.name.text}.${name} does not exist`);
    }
  };

  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) visitImport(node);
    if (ts.isDecorator(node)) visitDecorator(node);
    if (ts.isInterfaceDeclaration(node)) visitInterface(node);

    // Children first, so a call's receiver is typed before the call itself.
    ts.forEachChild(node, visit);

    if (ts.isCallExpression(node) && !decoratorCalls.has(node)) visitCall(node);
    else if (ts.isNewExpression(node)) visitNew(node);
    else if (ts.isVariableDeclaration(node)) {
      const annotated = typeFromAnnotation(node.type);
      const constructed = node.initializer && ts.isNewExpression(node.initializer);
      declare(node.name, annotated ?? typeOf(node.initializer), !!annotated || constructed);
    } else if ((ts.isParameter(node) || ts.isPropertyDeclaration(node)) && node.type) {
      declare(node.name, typeFromAnnotation(node.type), true);
    } else if (ts.isClassDeclaration(node) && node.name) {
      locals.set(node.name.text, null);
    } else if (
      ts.isPropertyAccessExpression(node)
      && !((ts.isCallExpression(node.parent) || ts.isNewExpression(node.parent)) && node.parent.expression === node)
    ) {
      // A property read (not a call) on an ORM result type.
      const receiver = typeOf(node.expression);
      if (checkable(receiver) && !memberOf(receiver, node.name.text)) {
        const assigned = ts.isBinaryExpression(node.parent) && node.parent.left === node;
        if (!assigned) report(lineOf(node.name), `${typeName(receiver)}.${node.name.text} does not exist`);
      }
    }
  };
  visit(source);
}

// ── Tables ─────────────────────────────────────────────────────────────

function splitRow(line) {
  const cells = [];
  let cell = "";
  for (let i = 1; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\" && line[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (ch === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += ch;
    }
  }
  return cells;
}

/** Parameter counts of a documented signature such as `<T>(entity, option?): R`. */
function documentedArity(text) {
  let i = 0;
  if (text[i] === "<") {
    for (let depth = 0; i < text.length; i++) {
      if (text[i] === "<") depth++;
      else if (text[i] === ">" && --depth === 0) break;
    }
    i++;
  }
  while (text[i] === " ") i++;
  if (text[i] !== "(") return undefined;
  const params = [];
  let depth = 0;
  let current = "";
  for (i++; i < text.length; i++) {
    const ch = text[i];
    if ("(<[{".includes(ch)) depth++;
    if (")>]}".includes(ch)) {
      if (depth === 0 && ch === ")") break;
      if (!(ch === ">" && text[i - 1] === "=")) depth--;
    }
    if (ch === "," && depth === 0) {
      params.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) params.push(current.trim());
  let min = 0;
  let max = 0;
  for (const param of params) {
    if (param.startsWith("...")) return { min, max: Infinity };
    max++;
    const name = param.split(":")[0].trim();
    if (!(name.endsWith("?") || /=/.test(param.split(":")[0]))) min = max;
  }
  return { min, max };
}

/**
 * A documented parameter list matches when one signature, or the overloads
 * taken together, require the same arguments and take at least as many.
 */
function fitsDocumented(signatures, documented) {
  const ranges = signatures.map(arity);
  const strict = ranges.some(({ min, max }) => min === documented.min && documented.max <= max);
  const min = Math.min(...ranges.map((r) => r.min));
  const max = Math.max(...ranges.map((r) => r.max));
  return strict || (min === documented.min && documented.max <= max);
}

/** A usage such as `@Column(opts)`: the argument count has to be one a signature takes. */
function fitsUsage(signatures, count) {
  return signatures.some((s) => {
    const { min, max } = arity(s);
    return count >= min && count <= max;
  });
}

const CLASS_SECTIONS = new Map([
  ["EntityManager", () => ENTITY_MANAGER],
  ["BaseRepository", () => REPOSITORY],
]);

function checkTables(report, lines, isApiReference) {
  let sectionType;
  let tableHeader = null;
  let inFence = false;
  lines.forEach((line, index) => {
    const lineNo = index + 1;
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) return;
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const resolve = CLASS_SECTIONS.get(heading[1]);
      sectionType = isApiReference && resolve ? resolve() : undefined;
    }
    if (!line.startsWith("|")) {
      tableHeader = null;
      // A comma-separated list of member names, as the repository section has.
      if (sectionType && /^`\w+`(, `\w+`){2,}/.test(line)) {
        for (const [, name] of line.matchAll(/`(\w+)`/g)) {
          if (!memberOf(sectionType, name)) report(lineNo, `${typeName(sectionType)}.${name} does not exist`);
        }
      }
      return;
    }
    const cells = splitRow(line);
    if (!tableHeader) {
      tableHeader = cells;
      return;
    }
    if (/^-+$/.test(cells[0]?.replace(/:/g, ""))) return;

    // `@Name(a, b?)` rows, in any table. A list with a `?` is a signature, one
    // without is a usage (`@Column(opts)`); `@Name()` only names the decorator.
    const decorator = /^`@(\w+)(\(.+\))`$/.exec(cells[0] ?? "");
    if (decorator) {
      const symbol = exportedSymbol(decorator[1]);
      const documented = documentedArity(decorator[2]);
      if (symbol && symbol.flags & ts.SymbolFlags.Function && documented) {
        const signatures = callSignatures(symbol);
        const isSignature = documented.min !== documented.max;
        const fits = isSignature
          ? fitsDocumented(signatures, documented)
          : fitsUsage(signatures, documented.max);
        if (!fits) {
          report(lineNo, `@${decorator[1]}${decorator[2]} does not match its parameters (takes ${describeArity(signatures)} argument(s))`);
        }
      }
    }

    if (!isApiReference) return;

    if (tableHeader[0] === "Export") {
      for (const [, text] of (cells[0] ?? "").matchAll(/`([^`]+)`/g)) {
        const name = /^@?([A-Za-z_]\w*)/.exec(text)?.[1];
        if (name && !exportedSymbol(name)) report(lineNo, `${name} is not exported from the package`);
      }
      return;
    }

    const member = /^`(\w+)`$/.exec(cells[0] ?? "");
    if (!sectionType || !member || tableHeader[0] !== "Method") return;
    const symbol = memberOf(sectionType, member[1]);
    if (!symbol) {
      report(lineNo, `${typeName(sectionType)}.${member[1]} does not exist`);
      return;
    }
    const signatures = callSignatures(symbol);
    for (const [, text] of (cells[1] ?? "").matchAll(/`([^`]+)`/g)) {
      const documented = documentedArity(text);
      if (documented && !fitsDocumented(signatures, documented)) {
        report(lineNo, `${typeName(sectionType)}.${member[1]}${text.slice(text.indexOf("("))} does not match its parameters (takes ${describeArity(signatures)} argument(s))`);
      }
    }
  });
}

// ── Main ───────────────────────────────────────────────────────────────

function main() {
  const files = process.argv.length > 2
    ? process.argv.slice(2).map((f) => path.resolve(f))
    : markdownFiles();
  const problems = [];

  for (const file of files) {
    const lines = fs.readFileSync(file, "utf-8").split("\n");
    const report = (line, message) => problems.push(`${path.relative(ROOT, file)}:${line}  ${message}`);
    const scope = { imported: new Map(), locals: new Map() };
    for (const block of codeBlocks(lines)) checkBlock(report, block, scope);
    checkTables(report, lines, path.basename(file) === "api-reference.md");
  }

  for (const problem of problems) console.error(problem);
  const summary = `check-docs-api: scanned ${files.length} files, ${problems.length} mismatch(es)`;
  if (problems.length) {
    console.error(`\n${summary}`);
    process.exit(1);
  }
  console.log(summary);
}

main();
