import {
  FormulaError,
  allAssignments,
  collectVariables,
  evaluateFormula,
  parseFormula
} from './formula.js';

export const MAX_VARIABLES = 8;

export function checkEntailment(premiseTexts, conclusionText) {
  const premiseResults = premiseTexts.map((text, index) => {
    try {
      return { ast: parseFormula(text), text };
    } catch (error) {
      if (error instanceof FormulaError) {
        return { error: `前提 ${index + 1}：${error.message}` };
      }
      throw error;
    }
  });

  let conclusionAst;
  let conclusionError = null;
  try {
    conclusionAst = parseFormula(conclusionText);
  } catch (error) {
    if (error instanceof FormulaError) {
      conclusionError = error.message;
    } else {
      throw error;
    }
  }

  const premiseError = premiseResults.find((item) => item.error);
  if (premiseError || conclusionError) {
    return {
      ok: false,
      code: 'PARSE_ERROR',
      error: premiseError?.error || `结论：${conclusionError}`
    };
  }

  const premises = premiseResults.map((item) => item.ast);
  const variables = new Set();
  premises.forEach((ast) => collectVariables(ast, variables));
  collectVariables(conclusionAst, variables);

  if (variables.size > MAX_VARIABLES) {
    return {
      ok: false,
      code: 'TOO_MANY_VARIABLES',
      error: `至多允许 ${MAX_VARIABLES} 个变量，但公式中出现了 ${variables.size} 个：${[...variables].sort().join('、')}`
    };
  }

  const counterexamples = [];
  for (const assignment of allAssignments(variables)) {
    const premiseValues = premises.map((ast) => evaluateFormula(ast, assignment));
    if (
      premiseValues.every(Boolean) &&
      !evaluateFormula(conclusionAst, assignment)
    ) {
      counterexamples.push(assignment);
    }
  }

  return {
    ok: counterexamples.length === 0,
    code: counterexamples.length === 0 ? 'ENTAILED' : 'COUNTEREXAMPLE',
    variables: [...variables].sort(),
    counterexamples
  };
}
