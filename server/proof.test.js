import { describe, expect, it } from 'vitest';
import { checkEntailment } from '../server/semantics.js';
import { evaluateFormula, formatFormula, parseFormula, sameFormula } from '../server/formula.js';
import { verifyProof } from '../server/proof.js';

describe('公式解析与优先级', () => {
  it('按 !、&、|、-> 的优先级构建语法树', () => {
    const ast = parseFormula('!P & Q | R -> S');
    expect(ast.type).toBe('implies');
    expect(ast.left.type).toBe('or');
    expect(ast.left.left.type).toBe('and');
    expect(ast.left.left.left.type).toBe('not');
    expect(ast.right.type).toBe('variable');
  });

  it('括号覆盖默认优先级，蕴含右结合', () => {
    const ast = parseFormula('P & (Q | R)');
    expect(ast.left.name).toBe('P');
    expect(ast.right.type).toBe('or');

    const chained = parseFormula('P -> Q -> R');
    expect(chained.type).toBe('implies');
    expect(chained.left.name).toBe('P');
    expect(chained.right.type).toBe('implies');
  });

  it('拒绝未知符号并报告位置', () => {
    expect(() => parseFormula('P ^ Q')).toThrow(/位置 2/);
    expect(() => parseFormula('P ->')).toThrow(/公式意外结束/);
  });

  it('最小必要地重新打印括号', () => {
    expect(formatFormula(parseFormula('!P & Q'))).toBe('!P & Q');
    expect(formatFormula(parseFormula('(P & Q) | R'))).toBe('P & Q | R');
    expect(formatFormula(parseFormula('P & (Q | R)'))).toBe('P & (Q | R)');
    expect(formatFormula(parseFormula('P -> (Q -> R)'))).toBe('P -> Q -> R');
    expect(formatFormula(parseFormula('(P -> Q) -> R'))).toBe('(P -> Q) -> R');
  });

  it('按优先级求真值', () => {
    const ast = parseFormula('P & !Q | R');
    expect(evaluateFormula(ast, { P: true, Q: false, R: false })).toBe(true);
    expect(evaluateFormula(ast, { P: true, Q: true, R: false })).toBe(false);
    expect(evaluateFormula(ast, { P: false, Q: true, R: true })).toBe(true);
  });
});

describe('语义蕴含与穷举反例', () => {
  it('找到使所有前提真而结论假的真实反例', () => {
    const result = checkEntailment(['P -> Q'], 'Q');
    expect(result.code).toBe('COUNTEREXAMPLE');
    expect(result.counterexamples).toContainEqual({ P: false, Q: false });
  });

  it('证明错误但结论仍是重言式时不提供反例', () => {
    const result = checkEntailment([], 'P | !P');
    expect(result.ok).toBe(true);
    expect(result.code).toBe('ENTAILED');
    expect(result.counterexamples).toEqual([]);
  });

  it('限制至多 8 个变量', () => {
    const variables = Array.from({ length: 9 }, (_, index) => `V${index}`);
    const result = checkEntailment([variables.join(' & ')], variables[0]);
    expect(result.code).toBe('TOO_MANY_VARIABLES');
  });
});

describe('正确证明', () => {
  it('接受前提、蕴含消去与合取引入', () => {
    const result = verifyProof({
      premises: ['P', 'P -> Q'],
      conclusion: 'P & Q',
      steps: [
        { id: '1', formula: 'P', rule: 'premise', refs: [] },
        { id: '2', formula: 'P -> Q', rule: 'premise', refs: [] },
        { id: '3', formula: 'Q', rule: 'impl_elim', refs: ['2', '1'] },
        { id: '4', formula: 'P & Q', rule: 'and_intro', refs: ['1', '3'] }
      ]
    });

    expect(result).toMatchObject({ ok: true, valid: true, code: 'VALID_PROOF' });
    expect(result.derivations.at(-1).basis).toContain('合取引入');
  });

  it('接受开设假设并通过蕴含引入关闭指定假设', () => {
    const result = verifyProof({
      premises: ['P -> Q'],
      conclusion: 'P -> P & Q',
      steps: [
        { id: '1', formula: 'P -> Q', rule: 'premise', refs: [] },
        { id: '2', formula: 'P', rule: 'assumption', refs: [], label: 'h1' },
        { id: '3', formula: 'Q', rule: 'impl_elim', refs: ['1', '2'] },
        { id: '4', formula: 'P & Q', rule: 'and_intro', refs: ['2', '3'] },
        { id: '5', formula: 'P -> P & Q', rule: 'impl_intro', refs: ['4'], label: 'h1' }
      ]
    });

    expect(result).toMatchObject({ valid: true });
    expect(result.derivations.at(-1).basis).toContain('关闭假设 h1');
    expect(result.derivations.at(-1).basis).toContain('4（P & Q）');
  });
});

describe('作用域规则', () => {
  it('阻止在假设关闭后偷用其中间结论', () => {
    const result = verifyProof({
      premises: ['P -> Q'],
      conclusion: 'P & Q',
      steps: [
        { id: '1', formula: 'P -> Q', rule: 'premise', refs: [] },
        { id: '2', formula: 'P', rule: 'assumption', refs: [], label: 'h1' },
        { id: '3', formula: 'Q', rule: 'impl_elim', refs: ['1', '2'] },
        { id: '4', formula: 'P & Q', rule: 'and_intro', refs: ['2', '3'] },
        { id: '5', formula: 'P -> P & Q', rule: 'impl_intro', refs: ['4'], label: 'h1' },
        { id: '6', formula: 'Q', rule: 'and_elim', refs: ['4'] }
      ]
    });

    expect(result.valid).toBe(false);
    expect(result.code).toBe('SCOPE_VIOLATION');
    expect(result.error).toContain('已关闭假设');
  });

  it('关闭外层前必须先关闭内层假设', () => {
    const result = verifyProof({
      premises: [],
      conclusion: 'P -> P',
      steps: [
        { id: '1', formula: 'P', rule: 'assumption', refs: [], label: 'outer' },
        { id: '2', formula: 'Q', rule: 'assumption', refs: [], label: 'inner' },
        { id: '3', formula: 'P -> P', rule: 'impl_intro', refs: ['1'], label: 'outer' }
      ]
    });

    expect(result.code).toBe('SCOPE_VIOLATION');
    expect(result.error).toContain('内层假设');
  });

  it('不允许复用已关闭的标签', () => {
    const result = verifyProof({
      premises: [],
      conclusion: 'P -> P',
      steps: [
        { id: '1', formula: 'P', rule: 'assumption', refs: [], label: 'h1' },
        { id: '2', formula: 'P -> P', rule: 'impl_intro', refs: ['1'], label: 'h1' },
        { id: '3', formula: 'Q', rule: 'assumption', refs: [], label: 'h1' },
        { id: '4', formula: 'Q -> Q', rule: 'impl_intro', refs: ['3'], label: 'h1' },
        { id: '5', formula: 'P -> P', rule: 'premise', refs: [] }
      ]
    });

    expect(result.code).toBe('DUPLICATE_LABEL');
  });

  it('拒绝用假设外层结论进行空假设关闭', () => {
    const result = verifyProof({
      premises: ['Q'],
      conclusion: 'P -> Q',
      steps: [
        { id: '1', formula: 'Q', rule: 'premise', refs: [] },
        { id: '2', formula: 'P', rule: 'assumption', refs: [], label: 'h1' },
        { id: '3', formula: 'P -> Q', rule: 'impl_intro', refs: ['1'], label: 'h1' }
      ]
    });

    expect(result.code).toBe('SCOPE_VIOLATION');
    expect(result.error).toContain('不能只引用外层已有结论');
  });

  it('结束时仍有未关闭假设则拒绝', () => {
    const result = verifyProof({
      premises: ['P'],
      conclusion: 'P',
      steps: [
        { id: '1', formula: 'Q', rule: 'assumption', refs: [], label: 'h1' },
        { id: '2', formula: 'P', rule: 'premise', refs: [] }
      ]
    });

    expect(result.code).toBe('UNCLOSED_ASSUMPTION');
  });
});

describe('错误消去与第一处错误', () => {
  it('拒绝对非合取式使用合取消去', () => {
    const result = verifyProof({
      premises: ['P -> Q'],
      conclusion: 'P',
      steps: [
        { id: '1', formula: 'P -> Q', rule: 'premise', refs: [] },
        { id: '2', formula: 'P', rule: 'and_elim', refs: ['1'] }
      ]
    });

    expect(result.code).toBe('INVALID_AND_ELIM');
  });

  it('拒绝从合取式消去不属于它的公式', () => {
    const result = verifyProof({
      premises: ['P & Q'],
      conclusion: 'R',
      steps: [
        { id: '1', formula: 'P & Q', rule: 'premise', refs: [] },
        { id: '2', formula: 'R', rule: 'and_elim', refs: ['1'] }
      ]
    });

    expect(result.code).toBe('INVALID_AND_ELIM');
  });

  it('拒绝前件不匹配的蕴含消去', () => {
    const result = verifyProof({
      premises: ['P -> Q', 'R'],
      conclusion: 'Q',
      steps: [
        { id: '1', formula: 'P -> Q', rule: 'premise', refs: [] },
        { id: '2', formula: 'R', rule: 'premise', refs: [] },
        { id: '3', formula: 'Q', rule: 'impl_elim', refs: ['1', '2'] }
      ]
    });

    expect(result.code).toBe('INVALID_IMPL_ELIM');
  });

  it('只报告当前作用域内最早出现的错误，不扫描后续步骤', () => {
    const result = verifyProof({
      premises: [],
      conclusion: 'Q',
      steps: [
        { id: '1', formula: 'P', rule: 'premise', refs: [] },
        { id: '2', formula: 'Q', rule: 'and_elim', refs: ['1'] }
      ]
    });

    expect(result.code).toBe('NOT_A_PREMISE');
  });
  it('证明步骤错误且结论不被蕴含时，同时返回第一处错误和真实反例', () => {
    const result = verifyProof({
      premises: ['P -> Q'],
      conclusion: 'Q',
      steps: [
        { id: '1', formula: 'P -> Q', rule: 'premise', refs: [] },
        { id: '2', formula: 'Q', rule: 'and_elim', refs: ['1'] }
      ]
    });

    expect(result.valid).toBe(false);
    expect(result.code).toBe('INVALID_AND_ELIM');
    expect(result.semantics.entailed).toBe(false);
    expect(result.semantics.counterexamples).toEqual([{ P: false, Q: false }]);
  });

  it('证明步骤错误但结论仍为重言式时，语义部分不包含反例', () => {
    const result = verifyProof({
      premises: [],
      conclusion: 'P | !P',
      steps: [
        { id: '1', formula: 'P | !P', rule: 'premise', refs: [] }
      ]
    });

    expect(result.valid).toBe(false);
    expect(result.code).toBe('NOT_A_PREMISE');
    expect(result.semantics.entailed).toBe(true);
    expect(result.semantics.counterexamples).toEqual([]);
  });
});

describe('结构等价', () => {
  it('不同空格和括号但同结构的公式等价', () => {
    expect(sameFormula(parseFormula('P&(!Q)'), parseFormula('P & !Q'))).toBe(true);
    expect(sameFormula(parseFormula('P & Q'), parseFormula('Q & P'))).toBe(false);
  });
});
