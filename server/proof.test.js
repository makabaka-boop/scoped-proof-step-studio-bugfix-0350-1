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

describe('析取消去（两个已关闭的假设分支）', () => {
  const closedBranchSteps = [
    { id: '1', formula: 'A | B', rule: 'premise', refs: [] },
    { id: '2', formula: 'A -> Q', rule: 'premise', refs: [] },
    { id: '3', formula: 'B -> Q', rule: 'premise', refs: [] },
    { id: '4', formula: 'A', rule: 'assumption', refs: [], label: 'ha' },
    { id: '5', formula: 'Q', rule: 'impl_elim', refs: ['2', '4'] },
    { id: '6', formula: 'A -> Q', rule: 'impl_intro', refs: ['5'], label: 'ha' },
    { id: '7', formula: 'B', rule: 'assumption', refs: [], label: 'hb' },
    { id: '8', formula: 'Q', rule: 'impl_elim', refs: ['3', '7'] },
    { id: '9', formula: 'B -> Q', rule: 'impl_intro', refs: ['8'], label: 'hb' }
  ];

  it('接受用两个已关闭假设分支完成的析取消去，并在依据中记录分支标签', () => {
    const result = verifyProof({
      premises: ['A | B', 'A -> Q', 'B -> Q'],
      conclusion: 'Q',
      steps: [
        ...closedBranchSteps,
        { id: '10', formula: 'Q', rule: 'or_elim', refs: ['1', '6', '9'] }
      ]
    });

    expect(result).toMatchObject({ ok: true, valid: true, code: 'VALID_PROOF' });
    const basis = result.derivations.at(-1).basis;
    expect(basis).toContain('析取消去');
    expect(basis).toContain('关闭假设 ha');
    expect(basis).toContain('关闭假设 hb');
  });

  it('拒绝把未由分支关闭得到的普通蕴含前提当成两支证明', () => {
    const result = verifyProof({
      premises: ['A | B', 'A -> Q', 'B -> Q'],
      conclusion: 'Q',
      steps: [
        { id: '1', formula: 'A | B', rule: 'premise', refs: [] },
        { id: '2', formula: 'A -> Q', rule: 'premise', refs: [] },
        { id: '3', formula: 'B -> Q', rule: 'premise', refs: [] },
        { id: '4', formula: 'Q', rule: 'or_elim', refs: ['1', '2', '3'] }
      ]
    });

    expect(result.valid).toBe(false);
    expect(result.code).toBe('INVALID_OR_ELIM');
    expect(result.error).toContain('步骤 4');
    expect(result.error).toContain('蕴含引入');
  });

  it('拒绝把同一个已关闭分支同时当成左右两支', () => {
    const result = verifyProof({
      premises: ['A | A', 'A -> Q'],
      conclusion: 'Q',
      steps: [
        { id: '1', formula: 'A | A', rule: 'premise', refs: [] },
        { id: '2', formula: 'A -> Q', rule: 'premise', refs: [] },
        { id: '3', formula: 'A', rule: 'assumption', refs: [], label: 'ha' },
        { id: '4', formula: 'Q', rule: 'impl_elim', refs: ['2', '3'] },
        { id: '5', formula: 'A -> Q', rule: 'impl_intro', refs: ['4'], label: 'ha' },
        { id: '6', formula: 'Q', rule: 'or_elim', refs: ['1', '5', '5'] }
      ]
    });

    expect(result.code).toBe('INVALID_OR_ELIM');
    expect(result.error).toContain('两个不同的已关闭假设分支');
  });

  it('拒绝左右分支引用顺序颠倒', () => {
    const result = verifyProof({
      premises: ['A | B', 'A -> Q', 'B -> Q'],
      conclusion: 'Q',
      steps: [
        ...closedBranchSteps,
        { id: '10', formula: 'Q', rule: 'or_elim', refs: ['1', '9', '6'] }
      ]
    });

    expect(result.code).toBe('INVALID_OR_ELIM');
    expect(result.error).toContain('左分支');
  });

  it('拒绝两支结论不一致的析取消去', () => {
    const result = verifyProof({
      premises: ['A | B', 'A -> Q', 'B -> R'],
      conclusion: 'Q',
      steps: [
        { id: '1', formula: 'A | B', rule: 'premise', refs: [] },
        { id: '2', formula: 'A -> Q', rule: 'premise', refs: [] },
        { id: '3', formula: 'B -> R', rule: 'premise', refs: [] },
        { id: '4', formula: 'A', rule: 'assumption', refs: [], label: 'ha' },
        { id: '5', formula: 'Q', rule: 'impl_elim', refs: ['2', '4'] },
        { id: '6', formula: 'A -> Q', rule: 'impl_intro', refs: ['5'], label: 'ha' },
        { id: '7', formula: 'B', rule: 'assumption', refs: [], label: 'hb' },
        { id: '8', formula: 'R', rule: 'impl_elim', refs: ['3', '7'] },
        { id: '9', formula: 'B -> R', rule: 'impl_intro', refs: ['8'], label: 'hb' },
        { id: '10', formula: 'Q', rule: 'or_elim', refs: ['1', '6', '9'] }
      ]
    });

    expect(result.code).toBe('INVALID_OR_ELIM');
    expect(result.error).toContain('两支结论不一致');
  });

  it('拒绝第一个引用不是析取式的析取消去', () => {
    const result = verifyProof({
      premises: ['A | B', 'A -> Q', 'B -> Q'],
      conclusion: 'Q',
      steps: [
        ...closedBranchSteps,
        { id: '10', formula: 'Q', rule: 'or_elim', refs: ['2', '6', '9'] }
      ]
    });

    expect(result.code).toBe('INVALID_OR_ELIM');
    expect(result.error).toContain('第一个引用必须是析取式');
  });

  it('外层假设仍开启时得到的析取结论，关闭外层后不得继续引用；语义反例一并返回', () => {
    const result = verifyProof({
      premises: ['A | B'],
      conclusion: 'Q',
      steps: [
        { id: '1', formula: 'A | B', rule: 'premise', refs: [] },
        { id: '2', formula: 'Q', rule: 'assumption', refs: [], label: 'h1' },
        { id: '3', formula: 'A', rule: 'assumption', refs: [], label: 'ha' },
        { id: '4', formula: 'Q & Q', rule: 'and_intro', refs: ['2', '2'] },
        { id: '5', formula: 'Q', rule: 'and_elim', refs: ['4'] },
        { id: '6', formula: 'A -> Q', rule: 'impl_intro', refs: ['5'], label: 'ha' },
        { id: '7', formula: 'B', rule: 'assumption', refs: [], label: 'hb' },
        { id: '8', formula: 'Q & Q', rule: 'and_intro', refs: ['2', '2'] },
        { id: '9', formula: 'Q', rule: 'and_elim', refs: ['8'] },
        { id: '10', formula: 'B -> Q', rule: 'impl_intro', refs: ['9'], label: 'hb' },
        { id: '11', formula: 'Q', rule: 'or_elim', refs: ['1', '6', '10'] },
        { id: '12', formula: 'Q -> Q', rule: 'impl_intro', refs: ['11'], label: 'h1' },
        { id: '13', formula: 'Q', rule: 'impl_elim', refs: ['12', '11'] }
      ]
    });

    expect(result.valid).toBe(false);
    expect(result.code).toBe('SCOPE_VIOLATION');
    expect(result.stepId).toBe('13');
    expect(result.error).toContain('已关闭假设');
    expect(result.semantics.entailed).toBe(false);
    expect(result.semantics.counterexamples).toContainEqual({ A: true, B: false, Q: false });
  });

  it('接受析取结论留在外层假设内、由蕴含引入正确关闭外层的嵌套证明', () => {
    const result = verifyProof({
      premises: ['A | B', 'A -> Q', 'B -> Q'],
      conclusion: 'P -> Q',
      steps: [
        { id: '1', formula: 'A | B', rule: 'premise', refs: [] },
        { id: '2', formula: 'A -> Q', rule: 'premise', refs: [] },
        { id: '3', formula: 'B -> Q', rule: 'premise', refs: [] },
        { id: '4', formula: 'P', rule: 'assumption', refs: [], label: 'h1' },
        { id: '5', formula: 'A', rule: 'assumption', refs: [], label: 'ha' },
        { id: '6', formula: 'Q', rule: 'impl_elim', refs: ['2', '5'] },
        { id: '7', formula: 'A -> Q', rule: 'impl_intro', refs: ['6'], label: 'ha' },
        { id: '8', formula: 'B', rule: 'assumption', refs: [], label: 'hb' },
        { id: '9', formula: 'Q', rule: 'impl_elim', refs: ['3', '8'] },
        { id: '10', formula: 'B -> Q', rule: 'impl_intro', refs: ['9'], label: 'hb' },
        { id: '11', formula: 'Q', rule: 'or_elim', refs: ['1', '7', '10'] },
        { id: '12', formula: 'P -> Q', rule: 'impl_intro', refs: ['11'], label: 'h1' }
      ]
    });

    expect(result).toMatchObject({ ok: true, valid: true, code: 'VALID_PROOF' });
  });

  it('拒绝析取消去结论与两支共同结论不符', () => {
    const result = verifyProof({
      premises: ['A | B', 'A -> Q', 'B -> Q'],
      conclusion: 'Q',
      steps: [
        ...closedBranchSteps,
        { id: '10', formula: 'A', rule: 'or_elim', refs: ['1', '6', '9'] },
        { id: '11', formula: 'Q', rule: 'premise', refs: [] }
      ]
    });

    expect(result.code).toBe('INVALID_OR_ELIM');
    expect(result.error).toContain('共同结论');
  });
});

describe('嵌套假设与关闭后引用', () => {
  it('接受嵌套蕴含引入 P -> (Q -> P)', () => {
    const result = verifyProof({
      premises: [],
      conclusion: 'P -> (Q -> P)',
      steps: [
        { id: '1', formula: 'P', rule: 'assumption', refs: [], label: 'h1' },
        { id: '2', formula: 'Q', rule: 'assumption', refs: [], label: 'h2' },
        { id: '3', formula: 'P & P', rule: 'and_intro', refs: ['1', '1'] },
        { id: '4', formula: 'P', rule: 'and_elim', refs: ['3'] },
        { id: '5', formula: 'Q -> P', rule: 'impl_intro', refs: ['4'], label: 'h2' },
        { id: '6', formula: 'P -> (Q -> P)', rule: 'impl_intro', refs: ['5'], label: 'h1' }
      ]
    });

    expect(result).toMatchObject({ ok: true, valid: true, code: 'VALID_PROOF' });
  });

  it('蕴含引入关闭假设后，其结论仍可在当前作用域被后续步骤引用', () => {
    const result = verifyProof({
      premises: [],
      conclusion: '(P -> P) & (Q -> Q)',
      steps: [
        { id: '1', formula: 'P', rule: 'assumption', refs: [], label: 'h1' },
        { id: '2', formula: 'P -> P', rule: 'impl_intro', refs: ['1'], label: 'h1' },
        { id: '3', formula: 'Q', rule: 'assumption', refs: [], label: 'h2' },
        { id: '4', formula: 'Q -> Q', rule: 'impl_intro', refs: ['3'], label: 'h2' },
        { id: '5', formula: '(P -> P) & (Q -> Q)', rule: 'and_intro', refs: ['2', '4'] }
      ]
    });

    expect(result).toMatchObject({ ok: true, valid: true, code: 'VALID_PROOF' });
  });

  it('引用定位类错误同样携带独立语义检查结果', () => {
    const result = verifyProof({
      premises: ['P -> Q'],
      conclusion: 'Q',
      steps: [
        { id: '1', formula: 'P -> Q', rule: 'premise', refs: [] },
        { id: '2', formula: 'Q', rule: 'impl_elim', refs: ['1', '9'] }
      ]
    });

    expect(result.valid).toBe(false);
    expect(result.code).toBe('UNKNOWN_REFERENCE');
    expect(result.stepId).toBe('2');
    expect(result.semantics.entailed).toBe(false);
    expect(result.semantics.counterexamples).toEqual([{ P: false, Q: false }]);
  });
});

describe('结构等价', () => {
  it('不同空格和括号但同结构的公式等价', () => {
    expect(sameFormula(parseFormula('P&(!Q)'), parseFormula('P & !Q'))).toBe(true);
    expect(sameFormula(parseFormula('P & Q'), parseFormula('Q & P'))).toBe(false);
  });
});
