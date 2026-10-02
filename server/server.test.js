import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { server } from './server.js';

const validPayload = {
  premises: ['P', 'P -> Q'],
  conclusion: 'Q',
  steps: [
    { id: '1', formula: 'P', rule: 'premise', refs: [] },
    { id: '2', formula: 'P -> Q', rule: 'premise', refs: [] },
    { id: '3', formula: 'Q', rule: 'impl_elim', refs: ['2', '1'] }
  ]
};

function postJson(path, body) {
  return fetch(`http://localhost:${server.address().port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then((response) => response.json());
}

describe('HTTP API', () => {
  beforeAll(async () => {
    await new Promise((resolve) => server.listen(0, resolve));
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('/api/verify 独立验算并返回逐步依据', async () => {
    const result = await postJson('/api/verify', validPayload);
    expect(result).toMatchObject({
      ok: true,
      valid: true,
      code: 'VALID_PROOF'
    });
    expect(result.derivations).toHaveLength(3);
  });

  it('/api/verify 拦截作用域泄漏', async () => {
    const leakedPayload = {
      premises: ['P -> Q'],
      conclusion: 'Q',
      steps: [
        { id: '1', formula: 'P -> Q', rule: 'premise', refs: [] },
        { id: '2', formula: 'P', rule: 'assumption', refs: [], label: 'h1' },
        { id: '3', formula: 'Q', rule: 'impl_elim', refs: ['1', '2'] },
        { id: '4', formula: 'P -> Q', rule: 'impl_intro', refs: ['1'], label: 'h1' },
        { id: '5', formula: 'Q', rule: 'impl_elim', refs: ['4', '2'] }
      ]
    };
    const result = await postJson('/api/verify', leakedPayload);
    expect(result.code).toBe('SCOPE_VIOLATION');
  });

  it('/api/entailment 在结论非蕴含时返回穷举反例', async () => {
    const result = await postJson('/api/entailment', {
      premises: ['P -> Q'],
      conclusion: 'Q'
    });
    expect(result.code).toBe('COUNTEREXAMPLE');
    expect(result.counterexamples).toEqual([{ P: false, Q: false }]);
  });
});
