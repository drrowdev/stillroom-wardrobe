import { readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { isMain, relativePath, walkFiles } from './quality/files.mjs';

const languages = ['en', 'fi', 'sv'];
const brands = new Set(['Stillroom', 'WARDROBE', 'Stillroom Wardrobe']);
const textAttributes = new Set(['alt', 'title', 'placeholder', 'aria-label', 'aria-description', 'aria-valuetext', 'label']);
const parameterPattern = /\{([A-Za-z][A-Za-z0-9]*)\}/g;
const parameterNames = (text) => [...new Set([...text.matchAll(parameterPattern)].map((match) => match[1]))].sort();
const equalNames = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export function validateCatalogs(catalogs) {
  const errors = [];
  const messages = Object.create(null);
  for (const [index, catalog] of catalogs.entries()) {
    if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
      errors.push(`catalog-${index}: INVALID_CATALOG`);
      continue;
    }
    for (const [key, entry] of Object.entries(catalog)) {
      if (Object.hasOwn(messages, key)) errors.push(`${key}: DUPLICATE_KEY`);
      messages[key] = entry;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        errors.push(`${key}: INVALID_ENTRY`);
        continue;
      }
      for (const language of languages) {
        if (typeof entry[language] !== 'string' || !entry[language].trim()) {
          errors.push(`${key}/${language}: MISSING_TRANSLATION`);
        } else if (/[{}]/.test(entry[language].replace(parameterPattern, ''))) {
          errors.push(`${key}/${language}: INVALID_PARAMETER`);
        }
      }
      if (languages.every((language) => typeof entry[language] === 'string')) {
        const expected = parameterNames(entry.en);
        if (languages.some((language) => !equalNames(expected, parameterNames(entry[language])))) {
          errors.push(`${key}: PARAMETER_MISMATCH`);
        }
      }
      if (Object.keys(entry).some((language) => !languages.includes(language))) errors.push(`${key}: UNKNOWN_LANGUAGE`);
    }
  }
  for (const key of Object.keys(messages)) {
    const plural = /_(zero|one|two|few|many|other)$/.exec(key);
    if (!plural) continue;
    if (!['one', 'other'].includes(plural[1])) errors.push(`${key}: UNSUPPORTED_PLURAL`);
    const base = key.slice(0, -plural[0].length);
    const one = messages[`${base}_one`];
    const other = messages[`${base}_other`];
    if (!one || !other) errors.push(`${base}: MISSING_PLURAL_PAIR`);
    else if (languages.some((language) => typeof one[language] !== 'string' || typeof other[language] !== 'string'
      || !equalNames(parameterNames(one[language]), parameterNames(other[language])))) {
      errors.push(`${base}: PLURAL_PARAMETER_MISMATCH`);
    }
  }
  return { messages, errors: [...new Set(errors)] };
}

export function parseCatalog(text, filename = 'catalog.json') {
  const source = ts.parseJsonText(filename, text);
  const errors = [];
  function visit(node) {
    if (ts.isObjectLiteralExpression(node)) {
      const seen = new Set();
      for (const property of node.properties) {
        const key = property.name && (ts.isStringLiteral(property.name) || ts.isIdentifier(property.name)) ? property.name.text : null;
        if (key !== null && seen.has(key)) errors.push(`${filename}: DUPLICATE_JSON_PROPERTY`);
        seen.add(key);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  try {
    return { catalog: JSON.parse(text), errors };
  } catch {
    return { catalog: null, errors: [...errors, `${filename}: INVALID_JSON`] };
  }
}

function unwrap(node) {
  while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
    || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node))) node = node.expression;
  return node;
}

function literalStrings(node) {
  node = unwrap(node);
  if (!node) return [];
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node];
  if (ts.isConditionalExpression(node)) return [...literalStrings(node.whenTrue), ...literalStrings(node.whenFalse)];
  if (ts.isBinaryExpression(node) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind)) {
    return [...literalStrings(node.left), ...literalStrings(node.right)];
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return literalStrings(node.right);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) return [...literalStrings(node.left), ...literalStrings(node.right)];
  if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap(literalStrings);
  if (ts.isTemplateExpression(node)) return [node.head, ...node.templateSpans.map((span) => span.literal)].filter((part) => part.text.trim());
  return [];
}

function elementOpening(node) {
  return ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null;
}

function textExempt(node, text) {
  if (!text.trim() || brands.has(text.trim())) return true;
  for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
    const opening = elementOpening(ancestor);
    if (!opening) continue;
    const tag = opening.tagName.getText();
    // Only syntax-shaped commands/filenames are exempt; prose inside <code> still needs translation.
    if (tag === 'code' && (/^(?:npm|node|npx) (?:[A-Za-z0-9@:_./\\=-]+ ?)+$/.test(text.trim())
      || /^(?:\.env(?:\.[\w-]+)?|[\w-]+(?:\.[\w-]+)+)$/.test(text.trim()))) return true;
    const hidden = opening.attributes.properties.some((attribute) => ts.isJsxAttribute(attribute)
      && attribute.name.getText() === 'aria-hidden'
      && (attribute.initializer && (ts.isStringLiteral(attribute.initializer) && attribute.initializer.text === 'true'
        || ts.isJsxExpression(attribute.initializer) && attribute.initializer.expression?.kind === ts.SyntaxKind.TrueKeyword)));
    if (hidden && /^[\d\s\p{P}\p{S}]+$/u.test(text)) return true;
  }
  return false;
}

export function checkSource(source, messages, checker = null) {
  const errors = [];
  const report = (node, code) => errors.push(`${source.fileName}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${code}`);
  const raw = (node) => {
    if (!textExempt(node, node.text)) report(node, 'RAW_UI_TEXT');
  };
  const rawExpression = (expression) => {
    if (!expression) return;
    const literals = literalStrings(expression);
    literals.forEach(raw);
    if (!literals.length && checker) {
      const type = checker.getTypeAtLocation(expression);
      const parts = type.isUnion() ? type.types : [type];
      if (parts.some((part) => part.flags & ts.TypeFlags.StringLiteral && !textExempt(expression, part.value))) {
        report(expression, 'RAW_UI_TEXT');
      }
    }
  };
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const call = node.expression;
      const name = ts.isIdentifier(call) ? call.text : ts.isPropertyAccessExpression(call) ? call.name.text : '';
      const argument = node.arguments[name === 'translate' ? 1 : 0];
      if (['t', 'translate'].includes(name) && argument) {
        for (const literal of literalStrings(argument).filter((literal) => ts.isStringLiteral(literal) || ts.isNoSubstitutionTemplateLiteral(literal))) {
          if (!Object.hasOwn(messages, literal.text)) report(literal, 'UNKNOWN_MESSAGE_KEY');
        }
        if (checker) {
          const type = checker.getTypeAtLocation(argument);
          const parts = type.isUnion() ? type.types : [type];
          if (parts.some((part) => !(part.flags & ts.TypeFlags.StringLiteral) || !Object.hasOwn(messages, part.value))) {
            report(argument, 'UNSAFE_MESSAGE_KEY_TYPE');
          }
        }
      }
    }
    if (ts.isJsxText(node)) raw(node);
    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText();
      const opening = node.parent.parent;
      const tag = opening.tagName?.getText();
      const isButtonValue = name === 'value' && tag === 'input' && opening.attributes.properties.some((attribute) =>
        ts.isJsxAttribute(attribute) && attribute.name.getText() === 'type' && attribute.initializer
        && ts.isStringLiteral(attribute.initializer) && ['button', 'submit', 'reset'].includes(attribute.initializer.text));
      if (textAttributes.has(name) || isButtonValue) {
        const value = node.initializer;
        if (value && ts.isStringLiteral(value)) raw(value);
        else if (value && ts.isJsxExpression(value)) rawExpression(value.expression);
      }
    }
    if (ts.isJsxExpression(node) && node.parent && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      rawExpression(node.expression);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return [...new Set(errors)];
}

export async function checkTranslations(root = process.cwd()) {
  const errors = [];
  const catalogs = [];
  for (const filename of ['messages.json', 'phase-zero.json']) {
    const parsed = parseCatalog(await readFile(path.join(root, 'src', 'i18n', filename), 'utf8'), filename);
    catalogs.push(parsed.catalog);
    errors.push(...parsed.errors);
  }
  const result = validateCatalogs(catalogs);
  errors.push(...result.errors);
  const files = (await walkFiles(path.join(root, 'src'))).filter((filename) => /\.(?:tsx?|jsx?)$/.test(filename));
  const config = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);
  if (config.error) errors.push('tsconfig.json: INVALID_TYPESCRIPT_CONFIG');
  const parsed = ts.parseJsonConfigFileContent(config.config ?? {}, ts.sys, root);
  if (parsed.errors.length) errors.push('tsconfig.json: INVALID_TYPESCRIPT_CONFIG');
  const program = ts.createProgram(files, { ...parsed.options, noEmit: true });
  const checker = program.getTypeChecker();
  for (const filename of files) {
    const source = program.getSourceFile(filename);
    errors.push(...checkSource(source, result.messages, checker).map((error) => error.replace(source.fileName, relativePath(root, filename))));
  }
  return { errors, keyCount: Object.keys(result.messages).length, fileCount: files.length };
}

if (isMain(import.meta.url)) {
  try {
    const result = await checkTranslations();
    if (result.errors.length) {
      console.error(result.errors.join('\n'));
      process.exitCode = 1;
    } else console.log(`Translations: ${result.keyCount} keys in en/fi/sv; ${result.fileCount} source files checked.`);
  } catch {
    console.error('Translations: INPUT_UNAVAILABLE');
    process.exitCode = 1;
  }
}
