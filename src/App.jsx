import { useState } from 'react';

const RULES = [
  { value: 'premise', label: '前提', needsRefs: false, needsLabel: false },
  { value: 'assumption', label: '开设假设', needsRefs: false, needsLabel: true },
  { value: 'and_intro', label: '合取引入 ∧I', needsRefs: true, needsLabel: false },
  { value: 'and_elim', label: '合取消去 ∧E', needsRefs: true, needsLabel: false },
  { value: 'impl_elim', label: '蕴含消去 →E', needsRefs: true, needsLabel: false },
  { value: 'impl_intro', label: '蕴含引入 →I', needsRefs: true, needsLabel: true },
  { value: 'or_elim', label: '析取消去 ∨E（两支已关闭证明）', needsRefs: true, needsLabel: false }
];

const RULE_NAMES = Object.fromEntries(RULES.map((rule) => [rule.value, rule.label]));

const example = {
  premises: ['P', 'P -> Q'],
  conclusion: 'P & Q',
  steps: [
    { id: '1', formula: 'P', rule: 'premise', refs: [], label: '' },
    { id: '2', formula: 'P -> Q', rule: 'premise', refs: [], label: '' },
    { id: '3', formula: 'Q', rule: 'impl_elim', refs: ['2', '1'], label: '' },
    { id: '4', formula: 'P & Q', rule: 'and_intro', refs: ['1', '3'], label: '' }
  ]
};

const implicationExample = {
  premises: ['P -> Q'],
  conclusion: 'P -> P & Q',
  steps: [
    { id: '1', formula: 'P -> Q', rule: 'premise', refs: [], label: '' },
    { id: '2', formula: 'P', rule: 'assumption', refs: [], label: 'h1' },
    { id: '3', formula: 'Q', rule: 'impl_elim', refs: ['1', '2'], label: '' },
    { id: '4', formula: 'P & Q', rule: 'and_intro', refs: ['2', '3'], label: '' },
    { id: '5', formula: 'P -> P & Q', rule: 'impl_intro', refs: ['4'], label: 'h1' }
  ]
};

const emptyStep = (index) => ({
  id: String(index + 1),
  formula: '',
  rule: 'premise',
  refs: [],
  label: ''
});

function uid() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : String(Date.now() + Math.random());
}

function normalizeStep(step) {
  return {
    id: String(step.id ?? ''),
    formula: String(step.formula ?? ''),
    rule: String(step.rule ?? 'premise'),
    refs: Array.isArray(step.refs) ? step.refs.map(String) : [],
    label: String(step.label ?? '')
  };
}

export default function App() {
  const [premises, setPremises] = useState(example.premises);
  const [conclusion, setConclusion] = useState(example.conclusion);
  const [steps, setSteps] = useState(example.steps.map(normalizeStep));
  const [result, setResult] = useState(null);
  const [isChecking, setIsChecking] = useState(false);

  function makePayload(currentValues = { premises, conclusion, steps }) {
    return {
      premises: currentValues.premises.map((value) => value.trim()).filter(Boolean),
      conclusion: currentValues.conclusion.trim(),
      steps: currentValues.steps.map((step) => ({
        id: step.id,
        formula: step.formula.trim(),
        rule: step.rule,
        refs: step.refs.map((ref) => ref.trim()).filter(Boolean),
        label: step.label.trim()
      }))
    };
  }

  const currentSignature = JSON.stringify(makePayload());

  function updatePremise(index, value) {
    setPremises((current) => current.map((item, itemIndex) => (itemIndex === index ? value : item)));
  }

  function addPremise() {
    setPremises((current) => [...current, '']);
  }

  function removePremise(index) {
    setPremises((current) => current.filter((_, itemIndex) => itemIndex !== index));
  }

  function updateStep(id, patch) {
    setSteps((current) =>
      current.map((step) => (step.id === id ? { ...step, ...patch } : step))
    );
  }

  function addStep() {
    setSteps((current) => [...current, { ...emptyStep(current.length), id: uid() }]);
  }

  function removeStep(id) {
    setSteps((current) => current.filter((step) => step.id !== id));
  }

  function moveStep(index, direction) {
    setSteps((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function loadExample(nextExample) {
    setPremises(nextExample.premises);
    setConclusion(nextExample.conclusion);
    setSteps(nextExample.steps.map((step) => ({ ...normalizeStep(step), id: uid() })));
    setResult(null);
  }

  async function checkProof() {
    const payload = makePayload();
    const stamp = JSON.stringify(payload);
    setIsChecking(true);
    try {
      const response = await fetch('/api/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await response.json();
      setResult({ data, stamp });
    } catch (error) {
      setResult({
        data: {
          ok: false,
          code: 'NETWORK_ERROR',
          error: `无法连接后端验算服务：${error.message}`
        },
        stamp
      });
    } finally {
      setIsChecking(false);
    }
  }

  const resultIsCurrent = result?.stamp === currentSignature;

  return (
    <main className="page-shell">
      <section className="hero">
        <div>
          <p className="eyebrow">Natural Deduction · Propositional Logic</p>
          <h1>命题逻辑证明检查器</h1>
          <p className="subtitle">
            支持变量、!、&amp;、|、-&gt; 与括号。后端独立解析和验算每个引用；关闭后的假设结论不会泄漏到外层作用域。
          </p>
        </div>
        <div className="hero-actions">
          <button type="button" onClick={() => loadExample(example)}>载入合取消去例</button>
          <button type="button" className="secondary" onClick={() => loadExample(implicationExample)}>
            载入蕴含引入例
          </button>
        </div>
      </section>

      <section className="card" aria-labelledby="formulas-title">
        <div className="card-header">
          <h2 id="formulas-title">前提与结论</h2>
          <span className="hint">优先级：! &gt; &amp; &gt; | &gt; -&gt;</span>
        </div>

        <div className="formula-grid">
          <div className="premise-list">
            <div className="section-label">前提</div>
            {premises.map((premise, index) => (
              <div className="formula-row" key={index}>
                <span className="formula-index">{index + 1}</span>
                <input
                  aria-label={`前提 ${index + 1}`}
                  value={premise}
                  onChange={(event) => updatePremise(index, event.target.value)}
                  placeholder="例如 P & (P -> Q)"
                />
                <button
                  type="button"
                  className="icon-button danger"
                  aria-label={`删除前提 ${index + 1}`}
                  onClick={() => removePremise(index)}
                >
                  删除
                </button>
              </div>
            ))}
            <button type="button" className="secondary compact" onClick={addPremise}>+ 添加前提</button>
          </div>

          <div className="conclusion-box">
            <label className="section-label" htmlFor="conclusion">最终结论</label>
            <input
              id="conclusion"
              value={conclusion}
              onChange={(event) => {
                setConclusion(event.target.value);
              }}
              placeholder="例如 Q"
            />
            <p className="hint">若结论不被前提蕴含，后端会穷举至多 8 个变量的赋值并给出真实反例。</p>
          </div>
        </div>
      </section>

      <section className="card" aria-labelledby="steps-title">
        <div className="card-header">
          <h2 id="steps-title">逐步证明</h2>
          <button type="button" className="compact" onClick={addStep}>+ 添加步骤</button>
        </div>

        <div className="step-list">
          <div className="step-row step-head" role="row">
            <span>#</span>
            <span>公式</span>
            <span>规则</span>
            <span>引用（逗号分隔）</span>
            <span>假设标签</span>
            <span>操作</span>
          </div>
          {steps.map((step, index) => {
            const selectedRule = RULES.find((rule) => rule.value === step.rule) || RULES[0];
            return (
              <div className="step-row" role="row" key={step.id}>
                <strong>{index + 1}</strong>
                <input
                  aria-label={`第 ${index + 1} 步公式`}
                  value={step.formula}
                  onChange={(event) => updateStep(step.id, { formula: event.target.value })}
                  placeholder="公式"
                />
                <select
                  aria-label={`第 ${index + 1} 步规则`}
                  value={step.rule}
                  onChange={(event) => updateStep(step.id, { rule: event.target.value })}
                >
                  {RULES.map((rule) => (
                    <option key={rule.value} value={rule.value}>{rule.label}</option>
                  ))}
                </select>
                <input
                  aria-label={`第 ${index + 1} 步引用`}
                  value={step.refs.join(', ')}
                  disabled={!selectedRule.needsRefs}
                  onChange={(event) =>
                    updateStep(step.id, {
                      refs: event.target.value
                        .split(',')
                        .map((item) => item.trim())
                        .filter(Boolean)
                    })
                  }
                  placeholder="如 1, 2"
                />
                <input
                  aria-label={`第 ${index + 1} 步假设标签`}
                  value={step.label}
                  disabled={!selectedRule.needsLabel}
                  onChange={(event) => updateStep(step.id, { label: event.target.value })}
                  placeholder="h1"
                />
                <div className="step-actions">
                  <button type="button" className="icon-button" onClick={() => moveStep(index, -1)}>↑</button>
                  <button type="button" className="icon-button" onClick={() => moveStep(index, 1)}>↓</button>
                  <button type="button" className="icon-button danger" onClick={() => removeStep(step.id)}>删</button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="checker-bar">
        <button type="button" className="primary" onClick={checkProof} disabled={isChecking}>
          {isChecking ? '正在提交后端验算…' : '提交后端验算'}
        </button>
        {result && !resultIsCurrent && (
          <p className="stale-warning" role="status">页面已在最近一次验算后修改；以下结果不属于当前内容。</p>
        )}
      </section>

      <ResultPanel result={result} />
    </main>
  );
}

function ResultPanel({ result }) {
  if (!result) {
    return (
      <section className="card result-card empty" aria-live="polite">
        <h2>验算结果</h2>
        <p>编辑后点击提交。结果只会来自后端对本次提交内容的重新解析与检查。</p>
      </section>
    );
  }

  const { data, stamp } = result;
  return (
    <section className={`card result-card ${data.valid ? 'valid' : 'invalid'}`} aria-live="polite">
      <h2>{data.valid ? '证明有效' : '发现问题'}</h2>
      <p className="result-message">{data.valid ? data.message : data.error}</p>

      {data.code === 'COUNTEREXAMPLE' && (
        <div className="counterexample-box">
          <h3>反例赋值</h3>
          <AssignmentTable assignments={data.counterexamples} />
        </div>
      )}

      {data.valid && data.derivations?.length > 0 && (
        <div className="derivation-box">
          <h3>后端给出的逐步依据</h3>
          <ol>
            {data.derivations.map((item) => (
              <li key={`${item.stepId}-${stamp}`}>
                <code>{item.formula}</code>
                <span>{RULE_NAMES[item.rule] || item.rule}</span>
                <p>{item.basis}</p>
              </li>
            ))}
          </ol>
        </div>
      )}

      {data.semantics && !data.semantics.entailed && (
        <div className="counterexample-box">
          <h3>语义反例：所有前提为真而结论为假的赋值</h3>
          <AssignmentTable assignments={data.semantics.counterexamples} />
        </div>
      )}

      {data.semantics?.entailed === false && data.valid === false && (
        <p className="hint">上面的证明错误与语义反例相互独立：即使修复证明规则，仍必须处理该反例。</p>
      )}

      {data.semantics?.entailed === true && data.valid === false && (
        <p className="hint">结论在语义上成立（无反例），但当前证明仍因上面的规则或作用域错误而无效。</p>
      )}
    </section>
  );
}

function AssignmentTable({ assignments }) {
  if (!assignments || assignments.length === 0) return <p>无反例。</p>;
  const variables = Object.keys(assignments[0]).sort();
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {variables.map((name) => <th key={name}>{name}</th>)}
          </tr>
        </thead>
        <tbody>
          {assignments.map((assignment, rowIndex) => (
            <tr key={rowIndex}>
              {variables.map((name) => <td key={name}>{assignment[name] ? 'T' : 'F'}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
