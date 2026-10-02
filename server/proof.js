import {
  FormulaError,
  collectVariables,
  formatFormula,
  parseFormula,
  sameFormula
} from './formula.js';
import { MAX_VARIABLES, checkEntailment } from './semantics.js';

const RULE_LABELS = {
  premise: '前提',
  assumption: '假设',
  and_intro: '合取引入',
  and_elim: '合取消去',
  impl_elim: '蕴含消去',
  impl_intro: '蕴含引入',
  or_elim: '析取消去'
};

function normalizeText(value) {
  return typeof value === 'string' ? value : '';
}

function normalizeRefs(refs) {
  if (refs === undefined || refs === null) return [];
  if (!Array.isArray(refs)) return [];
  return refs.map((ref) => String(ref));
}

function failure(code, error, extra = {}) {
  return { ok: false, valid: false, code, error, ...extra };
}

function parseAll(input) {
  const premiseTexts = Array.isArray(input.premises)
    ? input.premises.map(normalizeText)
    : [];
  const conclusionText = normalizeText(input.conclusion);
  const steps = Array.isArray(input.steps) ? input.steps : [];

  const premises = [];
  for (let i = 0; i < premiseTexts.length; i += 1) {
    try {
      premises.push(parseFormula(premiseTexts[i]));
    } catch (error) {
      if (error instanceof FormulaError) {
        return failure(
          'PARSE_ERROR',
          `前提 ${i + 1}：${error.message}`
        );
      }
      throw error;
    }
  }

  let conclusion;
  try {
    conclusion = parseFormula(conclusionText);
  } catch (error) {
    if (error instanceof FormulaError) {
      return failure('PARSE_ERROR', `结论：${error.message}`);
    }
    throw error;
  }

  const parsedSteps = [];
  const seenIds = new Set();
  const allVariables = new Set();
  premises.forEach((ast) => collectVariables(ast, allVariables));
  collectVariables(conclusion, allVariables);

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i] || {};
    const stepId = step.id === undefined || step.id === null ? String(i + 1) : String(step.id);

    if (seenIds.has(stepId)) {
      return failure(
        'DUPLICATE_STEP_ID',
        `步骤 ${stepId}：步骤编号重复`,
        { stepId }
      );
    }
    seenIds.add(stepId);

    let ast;
    try {
      ast = parseFormula(normalizeText(step.formula));
      collectVariables(ast, allVariables);
    } catch (error) {
      if (error instanceof FormulaError) {
        return failure(
          'PARSE_ERROR',
          `步骤 ${stepId}：${error.message}`,
          { stepId }
        );
      }
      throw error;
    }

    parsedSteps.push({
      source: step,
      id: stepId,
      index: i,
      rule: step.rule,
      ast,
      label: step.label === undefined || step.label === null ? '' : String(step.label),
      refs: normalizeRefs(step.refs),
      branches: normalizeRefs(step.branches)
    });
  }

  if (allVariables.size > MAX_VARIABLES) {
    return failure(
      'TOO_MANY_VARIABLES',
      `至多允许 ${MAX_VARIABLES} 个变量，但所有公式中共出现 ${allVariables.size} 个：${[...allVariables].sort().join('、')}`
    );
  }

  return { premiseTexts, premises, conclusionText, conclusion, steps: parsedSteps };
}

function ruleBasis(rule, step, records) {
  const referenced = (id) => `${id}（${formatFormula(records.get(id).ast)}）`;

  switch (rule) {
    case 'premise':
      return '给定前提';
    case 'assumption':
      return `开设假设 ${step.label}`;
    case 'and_intro':
      return `合取引入，引用 ${step.refs.map(referenced).join('、')}`;
    case 'and_elim':
      return `合取消去，引用 ${step.refs.map(referenced).join('、')}`;
    case 'impl_elim':
      return `蕴含消去（肯定前件），引用 ${step.refs.map(referenced).join('、')}`;
    case 'impl_intro':
      return `蕴含引入，关闭假设 ${step.label}，引用 ${step.refs.map(referenced).join('、')}`;
    case 'or_elim': {
      const branchLabels = Array.isArray(step.branchLabels) && step.branchLabels.length === 2
        ? `，两支假设 ${step.branchLabels[0]}、${step.branchLabels[1]}`
        : '';
      return `析取消去，引用 ${step.refs.map(referenced).join('、')}${branchLabels}`;
    }
    default:
      return RULE_LABELS[rule] || rule;
  }
}

function assertRefCount(step, expected) {
  if (step.refs.length !== expected) {
    return failure(
      'INVALID_REFERENCE',
      `步骤 ${step.id}：${RULE_LABELS[step.rule]}必须引用 ${expected} 个早期步骤，实际收到 ${step.refs.length} 个`,
      { stepId: step.id }
    );
  }
  return null;
}

function visible(record, currentScope) {
  return record.scopePath.every((label, index) => currentScope[index] === label);
}

function scopeEquals(scopePath, currentScope) {
  return scopePath.length === currentScope.length && visible({ scopePath }, currentScope);
}

function getVisibleRecord(step, refId, records, currentScope) {
  const record = records.get(refId);
  if (!record) {
    return {
      error: failure(
        'UNKNOWN_REFERENCE',
        `步骤 ${step.id}：引用了不存在的步骤“${refId}”`,
        { stepId: step.id }
      )
    };
  }
  if (!visible(record, currentScope)) {
    return {
      error: failure(
        'SCOPE_VIOLATION',
        `步骤 ${step.id}：不能引用“${refId}”，该结论位于已关闭假设“${record.scopePath[currentScope.length] ?? '未知作用域'}”内`,
        { stepId: step.id, reference: refId }
      )
    };
  }
  return { record };
}

class ProofFailure extends Error {
  constructor(result) {
    super(result.error);
    this.name = 'ProofFailure';
    this.result = result;
  }
}

function semanticsPayload(semantics) {
  return {
    entailed: semantics.code === 'ENTAILED',
    variables: semantics.variables,
    counterexamples: semantics.counterexamples
  };
}

export function verifyProof(input) {
  const parsed = parseAll(input);
  if (parsed.ok === false) return parsed;

  const semantics = checkEntailment(parsed.premiseTexts, parsed.conclusionText);
  if (semantics.code === 'TOO_MANY_VARIABLES') {
    return failure('TOO_MANY_VARIABLES', semantics.error);
  }

  try {
    return verifyParsedProof(parsed, semantics);
  } catch (error) {
    if (error instanceof ProofFailure) {
      return { ...error.result, semantics: semanticsPayload(semantics) };
    }
    throw error;
  }
}

function verifyParsedProof(parsed, semantics) {
  function reject(code, error, extra = {}) {
    throw new ProofFailure(failure(code, error, extra));
  }

  const { premises, conclusion, steps } = parsed;
  const records = new Map();
  const openFrames = [];
  const closedLabels = new Set();
  const derivations = [];

  for (const step of steps) {
    const currentScope = openFrames.map((frame) => frame.label);

    if (!Object.prototype.hasOwnProperty.call(RULE_LABELS, step.rule)) {
      reject(
        'UNKNOWN_RULE',
        `步骤 ${step.id}：未知证明规则“${step.rule}”`,
        { stepId: step.id }
      );
    }

    if (step.rule === 'premise') {
      if (step.refs.length !== 0) {
        reject(
          'INVALID_REFERENCE',
          `步骤 ${step.id}：前提步骤不能引用其他步骤`,
          { stepId: step.id }
        );
      }
      if (!premises.some((premise) => sameFormula(premise, step.ast))) {
        reject(
          'NOT_A_PREMISE',
          `步骤 ${step.id}：${formatFormula(step.ast)} 不是给定前提`,
          { stepId: step.id }
        );
      }
      records.set(step.id, {
        ast: step.ast,
        scopePath: currentScope,
        rule: step.rule
      });
    } else if (step.rule === 'assumption') {
      if (!step.label.trim()) {
        reject(
          'MISSING_LABEL',
          `步骤 ${step.id}：开设假设必须提供标签`,
          { stepId: step.id }
        );
      }
      if (records.has(step.label) || closedLabels.has(step.label) || openFrames.some((frame) => frame.label === step.label)) {
        reject(
          'DUPLICATE_LABEL',
          `步骤 ${step.id}：假设标签“${step.label}”已被使用`,
          { stepId: step.id, label: step.label }
        );
      }
      openFrames.push({
        label: step.label,
        assumption: step.ast,
        openedAt: step.id
      });
      records.set(step.id, {
        ast: step.ast,
        scopePath: [...currentScope, step.label],
        rule: step.rule,
        label: step.label
      });
    } else if (step.rule === 'and_intro') {
      const countError = assertRefCount(step, 2);
      if (countError) reject(countError.code, countError.error, { stepId: step.id });
      const refs = [];
      for (const refId of step.refs) {
        const result = getVisibleRecord(step, refId, records, currentScope);
        if (result.error) reject(result.error.code, result.error.error, { stepId: step.id, reference: refId });
        refs.push(result.record);
      }
      const expected = { type: 'and', left: refs[0].ast, right: refs[1].ast };
      if (!sameFormula(expected, step.ast)) {
        reject(
          'INVALID_AND_INTRO',
          `步骤 ${step.id}：合取引入应得到 ${formatFormula(expected)}，实际写成 ${formatFormula(step.ast)}`,
          { stepId: step.id }
        );
      }
      records.set(step.id, { ast: step.ast, scopePath: currentScope, rule: step.rule });
    } else if (step.rule === 'and_elim') {
      const countError = assertRefCount(step, 1);
      if (countError) reject(countError.code, countError.error, { stepId: step.id });
      const result = getVisibleRecord(step, step.refs[0], records, currentScope);
      if (result.error) reject(result.error.code, result.error.error, { stepId: step.id, reference: step.refs[0] });
      const source = result.record.ast;
      if (source.type !== 'and') {
        reject(
          'INVALID_AND_ELIM',
          `步骤 ${step.id}：合取消去只能用于合取式，但引用的是 ${formatFormula(source)}`,
          { stepId: step.id }
        );
      }
      if (!sameFormula(source.left, step.ast) && !sameFormula(source.right, step.ast)) {
        reject(
          'INVALID_AND_ELIM',
          `步骤 ${step.id}：${formatFormula(source)} 不能消去得到 ${formatFormula(step.ast)}`,
          { stepId: step.id }
        );
      }
      records.set(step.id, { ast: step.ast, scopePath: currentScope, rule: step.rule });
    } else if (step.rule === 'impl_elim') {
      const countError = assertRefCount(step, 2);
      if (countError) reject(countError.code, countError.error, { stepId: step.id });
      const implicationResult = getVisibleRecord(step, step.refs[0], records, currentScope);
      if (implicationResult.error) {
        reject(implicationResult.error.code, implicationResult.error.error, { stepId: step.id, reference: step.refs[0] });
      }
      const antecedentResult = getVisibleRecord(step, step.refs[1], records, currentScope);
      if (antecedentResult.error) {
        reject(antecedentResult.error.code, antecedentResult.error.error, { stepId: step.id, reference: step.refs[1] });
      }

      const implication = implicationResult.record.ast;
      const antecedent = antecedentResult.record.ast;
      if (implication.type !== 'implies') {
        reject(
          'INVALID_IMPL_ELIM',
          `步骤 ${step.id}：第一个引用必须是蕴含式，但实际是 ${formatFormula(implication)}`,
          { stepId: step.id }
        );
      }
      if (!sameFormula(implication.left, antecedent)) {
        reject(
          'INVALID_IMPL_ELIM',
          `步骤 ${step.id}：前件不匹配，蕴含式要求 ${formatFormula(implication.left)}，却引用 ${formatFormula(antecedent)}`,
          { stepId: step.id }
        );
      }
      if (!sameFormula(implication.right, step.ast)) {
        reject(
          'INVALID_IMPL_ELIM',
          `步骤 ${step.id}：蕴含消去应得到 ${formatFormula(implication.right)}，实际写成 ${formatFormula(step.ast)}`,
          { stepId: step.id }
        );
      }
      records.set(step.id, { ast: step.ast, scopePath: currentScope, rule: step.rule });
    } else if (step.rule === 'or_elim') {
      const countError = assertRefCount(step, 3);
      if (countError) reject(countError.code, countError.error, { stepId: step.id });
      const refs = [];
      for (const refId of step.refs) {
        const result = getVisibleRecord(step, refId, records, currentScope);
        if (result.error) reject(result.error.code, result.error.error, { stepId: step.id, reference: refId });
        refs.push(result.record);
      }
      const disjunction = refs[0].ast;
      const leftBranch = refs[1];
      const rightBranch = refs[2];

      // 第一个引用必须是析取式。
      if (disjunction.type !== 'or') {
        reject(
          'INVALID_OR_ELIM',
          `步骤 ${step.id}：析取消去的第一个引用必须是析取式 A | B，但实际是 ${formatFormula(disjunction)}`,
          { stepId: step.id }
        );
      }

      // 两支必须是“开设假设 -> 分支内推导 -> 蕴含引入关闭”得到的蕴含式。
      // 仅仅是前提（或其它途径）得到的蕴含公式不能充当两支已关闭证明。
      for (const [position, branchRecord] of [['第二个', leftBranch], ['第三个', rightBranch]]) {
        if (branchRecord.rule !== 'impl_intro') {
          reject(
            'OR_ELIM_REQUIRES_CLOSED_BRANCH',
            `步骤 ${step.id}：析取消去的${position}引用 ${formatFormula(branchRecord.ast)} 不是由“开设假设、在该假设作用域内推导、再用蕴含引入关闭假设”得到的两支证明，不能仅以一个普通蕴含式充当分支`,
            { stepId: step.id }
          );
        }
        // 两支必须在当前作用域关闭：若在更内层关闭，则其结论本就依赖那些内层假设；
        // 若在外层关闭，则不属于当前析取消去的两支子证明。
        if (!scopeEquals(branchRecord.scopePath, currentScope)) {
          reject(
            'OR_ELIM_BRANCH_SCOPE',
            `步骤 ${step.id}：${position}引用 ${formatFormula(branchRecord.ast)} 关闭假设“${branchRecord.dischargedLabel}”的位置不在当前作用域，不能作为当前析取消去的分支`,
            { stepId: step.id }
          );
        }
      }

      // 两支标签不得相同（同一假设不能充当两支不同的分支）。放在析取支匹配之前，
      // 以免同一引用既被当作左支又被当作右支时只报出次要的公式不匹配。
      if (leftBranch.dischargedLabel === rightBranch.dischargedLabel) {
        reject(
          'OR_ELIM_BRANCH_SCOPE',
          `步骤 ${step.id}：析取消去的两支必须是两个不同假设，但两次引用关闭的都是假设“${leftBranch.dischargedLabel}”`,
          { stepId: step.id }
        );
      }

      // 两支关闭的假设必须恰好分别是析取式的左、右析取支。
      if (!sameFormula(disjunction.left, leftBranch.dischargedAssumption) ||
          !sameFormula(disjunction.right, rightBranch.dischargedAssumption)) {
        reject(
          'INVALID_OR_ELIM',
          `步骤 ${step.id}：两支假设与析取式不匹配：析取式要求分别假设 ${formatFormula(disjunction.left)} 和 ${formatFormula(disjunction.right)}，但两支关闭的是 ${formatFormula(leftBranch.dischargedAssumption)} 和 ${formatFormula(rightBranch.dischargedAssumption)}`,
          { stepId: step.id }
        );
      }

      // 两支推出的结论必须一致，并等于本步声明的公式。
      if (!sameFormula(leftBranch.ast.right, rightBranch.ast.right) ||
          !sameFormula(step.ast, leftBranch.ast.right)) {
        reject(
          'INVALID_OR_ELIM',
          `步骤 ${step.id}：析取消去要求两支推出相同结论；两支分别得到 ${formatFormula(leftBranch.ast.right)} 和 ${formatFormula(rightBranch.ast.right)}，本步却写成 ${formatFormula(step.ast)}`,
          { stepId: step.id }
        );
      }

      step.branchLabels = [leftBranch.dischargedLabel, rightBranch.dischargedLabel];

      // 若学生显式填写了两支标签，必须与引用实际关闭的假设一致。
      if (step.branches.length > 0) {
        if (step.branches.length !== 2) {
          reject(
            'OR_ELIM_BRANCH_LABEL',
            `步骤 ${step.id}：析取消去需要提供两个不同的分支标签，实际收到 ${step.branches.length} 个`,
            { stepId: step.id }
          );
        }
        if (step.branches[0] !== step.branchLabels[0] || step.branches[1] !== step.branchLabels[1]) {
          reject(
            'OR_ELIM_BRANCH_LABEL',
            `步骤 ${step.id}：填写的分支标签 ${step.branches[0]}、${step.branches[1]} 与引用实际关闭的假设 ${step.branchLabels[0]}、${step.branchLabels[1]} 不一致`,
            { stepId: step.id }
          );
        }
      }

      // 关键：析取消去结论只解除两支分支假设，仍依赖当前作用域中尚未关闭的假设。
      // 绝不能无条件写成 []，否则在外层假设内得到的结论会在该外层假设关闭后泄漏。
      records.set(step.id, {
        ast: step.ast,
        scopePath: currentScope,
        rule: step.rule,
        branchLabels: step.branchLabels
      });
    } else if (step.rule === 'impl_intro') {
      const countError = assertRefCount(step, 1);
      if (countError) reject(countError.code, countError.error, { stepId: step.id });
      if (!step.label.trim()) {
        reject(
          'MISSING_LABEL',
          `步骤 ${step.id}：蕴含引入必须指定要关闭的假设标签`,
          { stepId: step.id }
        );
      }

      const frameIndex = openFrames.findIndex((frame) => frame.label === step.label);
      if (frameIndex === -1) {
        reject(
          'UNKNOWN_ASSUMPTION',
          `步骤 ${step.id}：找不到可关闭的未关闭假设“${step.label}”`,
          { stepId: step.id, label: step.label }
        );
      }
      if (frameIndex !== openFrames.length - 1) {
        reject(
          'SCOPE_VIOLATION',
          `步骤 ${step.id}：必须先关闭内层假设“${openFrames[openFrames.length - 1].label}”，不能直接关闭“${step.label}”`,
          { stepId: step.id, label: step.label }
        );
      }

      const frame = openFrames[frameIndex];
      const innerScope = [...currentScope];
      const refResult = getVisibleRecord(step, step.refs[0], records, innerScope);
      if (refResult.error) reject(refResult.error.code, refResult.error.error, { stepId: step.id, reference: step.refs[0] });
      const referencedRecord = refResult.record;
      if (referencedRecord.scopePath.length !== innerScope.length) {
        reject(
          'SCOPE_VIOLATION',
          `步骤 ${step.id}：蕴含引入引用的结论必须是在假设“${step.label}”作用域内推出的步骤，不能只引用外层已有结论`,
          { stepId: step.id, label: step.label }
        );
      }

      const expected = {
        type: 'implies',
        left: frame.assumption,
        right: referencedRecord.ast
      };
      if (!sameFormula(expected, step.ast)) {
        reject(
          'INVALID_IMPL_INTRO',
          `步骤 ${step.id}：关闭假设 ${step.label} 后应得到 ${formatFormula(expected)}，实际写成 ${formatFormula(step.ast)}`,
          { stepId: step.id }
        );
      }

      const newRecord = {
        // 关闭假设后，结论回到外层作用域：必须在 pop 之后确定 scopePath，
        // 否则结论会错误地留在已关闭假设的作用域里，外层既无法引用它，
        // 也会让析取消去等规则无法核对两支证明。
        ast: step.ast,
        scopePath: openFrames.slice(0, -1).map((item) => item.label),
        rule: step.rule,
        dischargedLabel: step.label,
        dischargedAssumption: frame.assumption
      };
      openFrames.pop();
      closedLabels.add(step.label);
      records.set(step.id, newRecord);
    }

    const derivation = {
      stepId: step.id,
      rule: step.rule,
      formula: formatFormula(step.ast),
      basis: ruleBasis(step.rule, step, records)
    };
    if (step.rule === 'or_elim') {
      derivation.branches = step.branchLabels;
    }
    derivations.push(derivation);
  }

  if (steps.length === 0) {
    reject('EMPTY_PROOF', '证明至少需要一个步骤');
  }

  if (openFrames.length > 0) {
    reject(
      'UNCLOSED_ASSUMPTION',
      `证明结束时仍有假设未关闭：${openFrames.map((frame) => frame.label).join('、')}`
    );
  }

  const lastStep = steps[steps.length - 1];
  if (!sameFormula(lastStep.ast, conclusion)) {
    reject(
      'WRONG_FINAL_CONCLUSION',
      `最后一步是 ${formatFormula(lastStep.ast)}，但声明的结论是 ${formatFormula(conclusion)}`
    );
  }

  return {
    ok: true,
    valid: true,
    code: 'VALID_PROOF',
    message: '证明有效：每一步均由指定规则和当前作用域内的早期步骤推出。',
    derivations,
    semantics: semanticsPayload(semantics)
  };
}

export function explainEntailment(input) {
  return checkEntailment(
    Array.isArray(input.premises) ? input.premises.map(normalizeText) : [],
    normalizeText(input.conclusion)
  );
}
