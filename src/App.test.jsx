import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App.jsx';

function mockVerifyImplementation(payload) {
  if (payload.conclusion === 'P & Q') {
    return {
      ok: true,
      valid: true,
      code: 'VALID_PROOF',
      message: '证明有效：每一步均由指定规则和当前作用域内的早期步骤推出。',
      derivations: [
        {
          stepId: '4',
          rule: 'and_intro',
          formula: 'P & Q',
          basis: '合取引入，引用 1（P）、3（Q）'
        }
      ],
      semantics: { entailed: true, variables: ['P', 'Q'], counterexamples: [] }
    };
  }

  return {
    ok: false,
    valid: false,
    code: 'INVALID_AND_ELIM',
    error: '步骤 6：合取消去只能用于合取式，但引用的是 P',
    semantics: {
      entailed: false,
      variables: ['P', 'Q', 'R'],
      counterexamples: [{ P: true, Q: true, R: false }]
    }
  };
}

function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('React 编辑与后端结果归属', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    global.fetch = vi.fn(async (url, options) => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return {
        ok: true,
        json: async () => mockVerifyImplementation(JSON.parse(options.body))
      };
    });
  });

  afterEach(async () => {
    await flushPromises();
    vi.restoreAllMocks();
  });

  it('把页面中的前提、结论和每一步提交给后端，而不是只依赖页面状态', async () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: '提交后端验算' }));

    await waitFor(() => expect(screen.getByText('证明有效')).toBeInTheDocument());
    expect(global.fetch).toHaveBeenCalledWith('/api/verify', expect.objectContaining({
      method: 'POST'
    }));

    const payload = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(payload).toMatchObject({
      premises: ['P', 'P -> Q'],
      conclusion: 'P & Q'
    });
    expect(payload.steps).toHaveLength(4);
    expect(payload.steps[2]).toMatchObject({
      rule: 'impl_elim',
      refs: ['2', '1']
    });
  });

  it('页面编辑后旧结果明确标记为不属于当前内容，再次验算才归属新内容', async () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: '提交后端验算' }));
    await screen.findByText('证明有效');

    fireEvent.change(screen.getByLabelText('最终结论'), { target: { value: 'R' } });

    expect(screen.getByRole('status')).toHaveTextContent('以下结果不属于当前内容');

    fireEvent.click(screen.getByRole('button', { name: '提交后端验算' }));
    await screen.findByText('发现问题');
    expect(screen.getByText(/合取消去只能用于合取式/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /语义反例/ })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'F' })).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('可以编辑证明步骤并删除前提', async () => {
    render(<App />);

    fireEvent.change(screen.getByLabelText('第 4 步公式'), { target: { value: 'Q' } });
    fireEvent.click(screen.getByLabelText('删除前提 2'));

    fireEvent.click(screen.getByRole('button', { name: '提交后端验算' }));

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
    const payload = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(payload.premises).toEqual(['P']);
    expect(payload.steps[3].formula).toBe('Q');
  });

  it('载入析取消去两支例时提交两支假设标签，而不是把前提当作分支', async () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: '载入析取消去两支例' }));
    fireEvent.click(screen.getByRole('button', { name: '提交后端验算' }));

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
    const payload = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(payload.premises).toEqual(['P | Q', 'P -> R', 'Q -> R']);
    expect(payload.conclusion).toBe('R');

    const lastStep = payload.steps.at(-1);
    expect(lastStep).toMatchObject({
      rule: 'or_elim',
      refs: ['1', '6', '9'],
      branches: ['a', 'b']
    });
    // 第二、三个引用必须是分别关闭假设 a、b 后得到的蕴含引入步骤。
    expect(payload.steps[5]).toMatchObject({ rule: 'impl_intro', label: 'a' });
    expect(payload.steps[8]).toMatchObject({ rule: 'impl_intro', label: 'b' });
  });
});
