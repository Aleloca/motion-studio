import { describe, expect, it } from 'vitest';
import { answersFor, askUserQuestionInputSchema, type AgentQuestion } from '../src/index.ts';

const q = (question: string): AgentQuestion => ({ question, header: '', multiSelect: false, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] });

describe('AskUserQuestion answers (user note 8, review fix)', () => {
  it('the answers object is a plain record: a question text that names an Object.prototype key is an own property', () => {
    const out = answersFor([q('__proto__'), q('toString')], [{ selected: [1] }, { selected: [0] }])!;
    expect(Object.hasOwn(out, '__proto__')).toBe(true);
    expect(out['__proto__']).toBe('B');
    expect(Object.hasOwn(out, 'toString')).toBe(true);
    expect(JSON.parse(JSON.stringify(out))).toEqual(JSON.parse('{"__proto__":"B","toString":"A"}'));
  });

  it('refuses the question texts __proto__, constructor and prototype', () => {
    for (const text of ['__proto__', 'constructor', 'prototype']) {
      const input = { questions: [{ question: text, options: [{ label: 'A' }, { label: 'B' }] }] };
      expect(askUserQuestionInputSchema.safeParse(input).success, text).toBe(false);
    }
    expect(askUserQuestionInputSchema.safeParse({ questions: [{ question: 'toString?', options: [{ label: 'A' }, { label: 'B' }] }] }).success).toBe(true);
  });
});
