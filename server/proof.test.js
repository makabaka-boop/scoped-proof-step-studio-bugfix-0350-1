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

describe('析取消去与两支分支', () => {
  // P | Q, P -> R, Q -> R 为给定前提；但学生必须分别开设假设 P、Q 推出 R，
  // 用蕴含引入关闭两支后，才能在顶层使用析取消去。
  function closedBranchProof(overrides = {}) {
    return {
      premises: ['P | Q', 'P -> R', 'Q -> R'],
      conclusion: 'R',
      steps: [
        { id: '1', formula: 'P | Q', rule: 'premise', refs: [] },
        { id: '2', formula: 'P -> R', rule: 'premise', refs: [] },
        { id: '3', formula: 'Q -> R', rule: 'premise', refs: [] },
        { id: '4', formula: 'P', rule: 'assumption', refs: [], label: 'a' },
        { id: '5', formula: 'R', rule: 'impl_elim', refs: ['2', '4'] },
        { id: '6', formula: 'P -> R', rule: 'impl_intro', refs: ['5'], label: 'a' },
        { id: '7', formula: 'Q', rule: 'assumption', refs: [], label: 'b' },
        { id: '8', formula: 'R', rule: 'impl_elim', refs: ['3', '7'] },
        { id: '9', formula: 'Q -> R', rule: 'impl_intro', refs: ['8'], label: 'b' },
        { id: '10', formula: 'R', rule: 'or_elim', refs: ['1', '6', '9'], branches: ['a', 'b'] }
      ],
      ...overrides
    };
  }

  it('接受两个假设分支分别关闭后在顶层完成的析取消去', () => {
    const result = verifyProof(closedBranchProof());
    expect(result).toMatchObject({ valid: true, code: 'VALID_PROOF' });
    const last = result.derivations.at(-1);
    expect(last.basis).toContain('析取消去');
    expect(last.basis).toContain('两支假设 a、b');
    expect(last.branches).toEqual(['a', 'b']);
  });

  it('拒绝把普通蕴含前提直接当成两支证明', () => {
    const result = verifyProof({
      premises: ['P | Q', 'P -> R', 'Q -> R'],
      conclusion: 'R',
      steps: [
        { id: '1', formula: 'P | Q', rule: 'premise', refs: [] },
        { id: '2', formula: 'P -> R', rule: 'premise', refs: [] },
        { id: '3', formula: 'Q -> R', rule: 'premise', refs: [] },
        { id: '4', formula: 'R', rule: 'or_elim', refs: ['1', '2', '3'] }
      ]
    });

    expect(result.valid).toBe(false);
    expect(result.code).toBe('OR_ELIM_REQUIRES_CLOSED_BRANCH');
    expect(result.error).toContain('两支证明');
  });

  it('即使引用顺序把两支写成 6、9 的形状，缺少假设关闭也不接受', () => {
    const result = verifyProof({
      premises: ['P | Q', 'P -> R', 'Q -> R'],
      conclusion: 'R',
      steps: [
        { id: '1', formula: 'P | Q', rule: 'premise', refs: [] },
        { id: '2', formula: 'P -> R', rule: 'premise', refs: [] },
        { id: '3', formula: 'Q -> R', rule: 'premise', refs: [] },
        { id: '4', formula: 'R', rule: 'or_elim', refs: ['1', '3', '2'] }
      ]
    });

    expect(result.code).toBe('OR_ELIM_REQUIRES_CLOSED_BRANCH');
  });

  it('阻止外层假设仍开启时得到的析取消去结论在关闭后被引用', () => {
    // 两支都依赖外层假设 T；析取消去只能得到“T 之下”的 R，关闭 T 后不得再引用。
    const result = verifyProof({
      premises: ['P | Q', 'T & P -> R', 'T & Q -> R'],
      conclusion: 'R',
      steps: [
        { id: '1', formula: 'P | Q', rule: 'premise', refs: [] },
        { id: '2', formula: 'T & P -> R', rule: 'premise', refs: [] },
        { id: '3', formula: 'T & Q -> R', rule: 'premise', refs: [] },
        { id: '4', formula: 'T', rule: 'assumption', refs: [], label: 'h0' },
        { id: '5', formula: 'P', rule: 'assumption', refs: [], label: 'a' },
        { id: '6', formula: 'T & P', rule: 'and_intro', refs: ['4', '5'] },
        { id: '7', formula: 'R', rule: 'impl_elim', refs: ['2', '6'] },
        { id: '8', formula: 'P -> R', rule: 'impl_intro', refs: ['7'], label: 'a' },
        { id: '9', formula: 'Q', rule: 'assumption', refs: [], label: 'b' },
        { id: '10', formula: 'T & Q', rule: 'and_intro', refs: ['4', '9'] },
        { id: '11', formula: 'R', rule: 'impl_elim', refs: ['3', '10'] },
        { id: '12', formula: 'Q -> R', rule: 'impl_intro', refs: ['11'], label: 'b' },
        { id: '13', formula: 'R', rule: 'or_elim', refs: ['1', '8', '12'], branches: ['a', 'b'] },
        { id: '14', formula: 'T -> T', rule: 'impl_intro', refs: ['4'], label: 'h0' },
        { id: '15', formula: 'R & R', rule: 'and_intro', refs: ['13', '13'] }
      ]
    });

    expect(result.valid).toBe(false);
    expect(result.code).toBe('SCOPE_VIOLATION');
    expect(result.error).toContain('步骤 15');
    expect(result.error).toContain('已关闭假设“h0”');
    // 语义检查独立报告该结论确有反例，绝不因错误证明被放行。
    expect(result.semantics.entailed).toBe(false);
    expect(result.semantics.counterexamples.length).toBeGreaterThan(0);
  });

  it('同一外层假设内完成析取消去后，可合法关闭外层并引用其结论', () => {
    const result = verifyProof({
      premises: ['P | Q'],
      conclusion: 'U -> U & U',
      steps: [
        { id: '1', formula: 'P | Q', rule: 'premise', refs: [] },
        { id: '2', formula: 'U', rule: 'assumption', refs: [], label: 'h0' },
        { id: '3', formula: 'P', rule: 'assumption', refs: [], label: 'a' },
        { id: '4', formula: 'U & U', rule: 'and_intro', refs: ['2', '2'] },
        { id: '5', formula: 'P -> U & U', rule: 'impl_intro', refs: ['4'], label: 'a' },
        { id: '6', formula: 'Q', rule: 'assumption', refs: [], label: 'b' },
        { id: '7', formula: 'U & U', rule: 'and_intro', refs: ['2', '2'] },
        { id: '8', formula: 'Q -> U & U', rule: 'impl_intro', refs: ['7'], label: 'b' },
        { id: '9', formula: 'U & U', rule: 'or_elim', refs: ['1', '5', '8'], branches: ['a', 'b'] },
        { id: '10', formula: 'U -> U & U', rule: 'impl_intro', refs: ['9'], label: 'h0' }
      ]
    });

    expect(result).toMatchObject({ valid: true, code: 'VALID_PROOF' });
  });

  it('拒绝两支标签相同的析取消去', () => {
    const proof = closedBranchProof();
    proof.steps[9] = {
      id: '10',
      formula: 'R',
      rule: 'or_elim',
      refs: ['1', '6', '6'],
      branches: ['a', 'a']
    };
    const result = verifyProof(proof);
    expect(result.valid).toBe(false);
    expect(result.code).toBe('OR_ELIM_BRANCH_SCOPE');
  });

  it('拒绝两支假设与析取式左右析取支不匹配', () => {
    // 第二支关闭的假设仍是 P，而析取式右侧是 Q。
    const result = verifyProof({
      premises: ['P | Q', 'P -> R'],
      conclusion: 'R',
      steps: [
        { id: '1', formula: 'P | Q', rule: 'premise', refs: [] },
        { id: '2', formula: 'P -> R', rule: 'premise', refs: [] },
        { id: '3', formula: 'P', rule: 'assumption', refs: [], label: 'a' },
        { id: '4', formula: 'R', rule: 'impl_elim', refs: ['2', '3'] },
        { id: '5', formula: 'P -> R', rule: 'impl_intro', refs: ['4'], label: 'a' },
        { id: '6', formula: 'P', rule: 'assumption', refs: [], label: 'b' },
        { id: '7', formula: 'R', rule: 'impl_elim', refs: ['2', '6'] },
        { id: '8', formula: 'P -> R', rule: 'impl_intro', refs: ['7'], label: 'b' },
        { id: '9', formula: 'R', rule: 'or_elim', refs: ['1', '5', '8'], branches: ['a', 'b'] }
      ]
    });

    expect(result.valid).toBe(false);
    expect(result.code).toBe('INVALID_OR_ELIM');
    expect(result.error).toContain('两支假设与析取式不匹配');
  });

  it('拒绝两支推出不同结论的析取消去', () => {
    const result = verifyProof({
      premises: ['P | Q', 'P -> R', 'Q -> S'],
      conclusion: 'R',
      steps: [
        { id: '1', formula: 'P | Q', rule: 'premise', refs: [] },
        { id: '2', formula: 'P -> R', rule: 'premise', refs: [] },
        { id: '3', formula: 'Q -> S', rule: 'premise', refs: [] },
        { id: '4', formula: 'P', rule: 'assumption', refs: [], label: 'a' },
        { id: '5', formula: 'R', rule: 'impl_elim', refs: ['2', '4'] },
        { id: '6', formula: 'P -> R', rule: 'impl_intro', refs: ['5'], label: 'a' },
        { id: '7', formula: 'Q', rule: 'assumption', refs: [], label: 'b' },
        { id: '8', formula: 'S', rule: 'impl_elim', refs: ['3', '7'] },
        { id: '9', formula: 'Q -> S', rule: 'impl_intro', refs: ['8'], label: 'b' },
        { id: '10', formula: 'R', rule: 'or_elim', refs: ['1', '6', '9'], branches: ['a', 'b'] }
      ]
    });

    expect(result.code).toBe('INVALID_OR_ELIM');
    expect(result.error).toContain('两支推出相同结论');
  });

  it('拒绝填写的两支标签与引用实际关闭的假设不一致', () => {
    const proof = closedBranchProof();
    proof.steps[9] = {
      id: '10',
      formula: 'R',
      rule: 'or_elim',
      refs: ['1', '6', '9'],
      branches: ['b', 'a']
    };
    const result = verifyProof(proof);
    expect(result.code).toBe('OR_ELIM_BRANCH_LABEL');
    expect(result.error).toContain('不一致');
  });

  it('拒绝引用仍在开启（未关闭）的分支假设', () => {
    const result = verifyProof({
      premises: ['P | Q', 'P -> R', 'Q -> R'],
      conclusion: 'R',
      steps: [
        { id: '1', formula: 'P | Q', rule: 'premise', refs: [] },
        { id: '2', formula: 'P -> R', rule: 'premise', refs: [] },
        { id: '3', formula: 'Q -> R', rule: 'premise', refs: [] },
        { id: '4', formula: 'P', rule: 'assumption', refs: [], label: 'a' },
        { id: '5', formula: 'R', rule: 'impl_elim', refs: ['2', '4'] },
        { id: '6', formula: 'Q', rule: 'assumption', refs: [], label: 'b' },
        { id: '7', formula: 'R', rule: 'impl_elim', refs: ['3', '6'] },
        { id: '8', formula: 'R', rule: 'or_elim', refs: ['1', '2', '3'] }
      ]
    });

    expect(result.code).toBe('OR_ELIM_REQUIRES_CLOSED_BRANCH');
  });
});

describe('结构等价', () => {
  it('不同空格和括号但同结构的公式等价', () => {
    expect(sameFormula(parseFormula('P&(!Q)'), parseFormula('P & !Q'))).toBe(true);
    expect(sameFormula(parseFormula('P & Q'), parseFormula('Q & P'))).toBe(false);
  });
});
