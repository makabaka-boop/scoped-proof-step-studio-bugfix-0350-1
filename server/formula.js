export class FormulaError extends Error {
  constructor(message, position = null) {
    super(position === null ? message : `${message}（位置 ${position}）`);
    this.name = 'FormulaError';
    this.position = position;
  }
}

const OPERATOR_PRECEDENCE = {
  not: 5,
  and: 4,
  or: 3,
  implies: 2
};

function isIdentifierStart(char) {
  return /[A-Za-z]/.test(char);
}

function isIdentifierPart(char) {
  return /[A-Za-z0-9]/.test(char);
}

function tokenize(input) {
  const tokens = [];
  let i = 0;

  while (i < input.length) {
    const char = input[i];

    if (/\s/.test(char)) {
      i += 1;
    } else if (char === '-' && input[i + 1] === '>') {
      tokens.push({ type: 'implies', value: '->', position: i });
      i += 2;
    } else if (char === '!') {
      tokens.push({ type: 'not', value: '!', position: i });
      i += 1;
    } else if (char === '&') {
      tokens.push({ type: 'and', value: '&', position: i });
      i += 1;
    } else if (char === '|') {
      tokens.push({ type: 'or', value: '|', position: i });
      i += 1;
    } else if (char === '(') {
      tokens.push({ type: 'lparen', value: '(', position: i });
      i += 1;
    } else if (char === ')') {
      tokens.push({ type: 'rparen', value: ')', position: i });
      i += 1;
    } else if (isIdentifierStart(char)) {
      const start = i;
      i += 1;
      while (i < input.length && isIdentifierPart(input[i])) {
        i += 1;
      }
      tokens.push({
        type: 'variable',
        value: input.slice(start, i),
        position: start
      });
    } else {
      throw new FormulaError(`无法识别的符号“${char}”`, i);
    }
  }

  return tokens;
}

export function parseFormula(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new FormulaError('公式不能为空');
  }

  const tokens = tokenize(input);
  if (tokens.length === 0) {
    throw new FormulaError('公式不能为空');
  }

  let index = 0;

  function current() {
    return tokens[index];
  }

  function consume(type) {
    const token = current();
    if (!token || token.type !== type) {
      const at = token ? token.position : input.length;
      throw new FormulaError(`期望“${typeLabel(type)}”`, at);
    }
    index += 1;
    return token;
  }

  function parseImplication() {
    const left = parseOr();
    if (current()?.type === 'implies') {
      consume('implies');
      const right = parseImplication();
      return { type: 'implies', left, right };
    }
    return left;
  }

  function parseOr() {
    let left = parseAnd();
    while (current()?.type === 'or') {
      consume('or');
      const right = parseAnd();
      left = { type: 'or', left, right };
    }
    return left;
  }

  function parseAnd() {
    let left = parseUnary();
    while (current()?.type === 'and') {
      consume('and');
      const right = parseUnary();
      left = { type: 'and', left, right };
    }
    return left;
  }

  function parseUnary() {
    if (current()?.type === 'not') {
      const token = consume('not');
      return { type: 'not', operand: parseUnary(), position: token.position };
    }
    return parsePrimary();
  }

  function parsePrimary() {
    const token = current();
    if (!token) {
      throw new FormulaError('公式意外结束', input.length);
    }

    if (token.type === 'variable') {
      consume('variable');
      return { type: 'variable', name: token.value };
    }

    if (token.type === 'lparen') {
      consume('lparen');
      const expression = parseImplication();
      consume('rparen');
      return expression;
    }

    throw new FormulaError(`意外的符号“${token.value}”`, token.position);
  }

  const ast = parseImplication();
  if (index < tokens.length) {
    throw new FormulaError(`意外的符号“${tokens[index].value}”`, tokens[index].position);
  }
  return ast;
}

function typeLabel(type) {
  return {
    variable: '变量',
    '!': '!',
    '&': '&',
    '|': '|',
    implies: '->',
    '(': '(',
    ')': ')'
  }[type] || type;
}

export function sameFormula(left, right) {
  if (left.type !== right.type) return false;
  if (left.type === 'variable') return left.name === right.name;
  if (left.type === 'not') return sameFormula(left.operand, right.operand);
  return sameFormula(left.left, right.left) && sameFormula(left.right, right.right);
}

export function collectVariables(node, variables = new Set()) {
  if (node.type === 'variable') {
    variables.add(node.name);
  } else if (node.type === 'not') {
    collectVariables(node.operand, variables);
  } else {
    collectVariables(node.left, variables);
    collectVariables(node.right, variables);
  }
  return variables;
}

export function formatFormula(node, parentPrecedence = 0, side = 'right') {
  if (node.type === 'variable') return node.name;

  if (node.type === 'not') {
    const text = `!${formatFormula(node.operand, OPERATOR_PRECEDENCE.not)}`;
    return parentPrecedence > OPERATOR_PRECEDENCE.not ? `(${text})` : text;
  }

  const precedence = OPERATOR_PRECEDENCE[node.type];
  const symbol = node.type === 'and' ? '&' : node.type === 'or' ? '|' : '->';
  const leftBinding = node.type === 'implies' ? precedence + 1 : precedence;
  const rightBinding = node.type === 'implies' ? precedence : precedence + 1;
  const left = formatFormula(node.left, leftBinding, 'left');
  const right = formatFormula(node.right, rightBinding, 'right');
  const text = `${left} ${symbol} ${right}`;
  const needsParens = parentPrecedence > precedence ||
    (parentPrecedence === precedence && side === 'left' && node.type === 'implies');

  return needsParens ? `(${text})` : text;
}

export function evaluateFormula(node, assignment) {
  switch (node.type) {
    case 'variable':
      return assignment[node.name] === true;
    case 'not':
      return !evaluateFormula(node.operand, assignment);
    case 'and':
      return evaluateFormula(node.left, assignment) && evaluateFormula(node.right, assignment);
    case 'or':
      return evaluateFormula(node.left, assignment) || evaluateFormula(node.right, assignment);
    case 'implies':
      return !evaluateFormula(node.left, assignment) || evaluateFormula(node.right, assignment);
    default:
      throw new Error(`未知公式节点类型：${node.type}`);
  }
}

export function allAssignments(variables) {
  const names = [...variables].sort();
  const count = names.length;
  const assignments = [];

  for (let mask = 0; mask < 2 ** count; mask += 1) {
    const assignment = {};
    names.forEach((name, bitIndex) => {
      assignment[name] = Boolean(mask & (1 << (count - 1 - bitIndex)));
    });
    assignments.push(assignment);
  }

  return assignments;
}
