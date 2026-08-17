import { describe, it, expect } from 'vitest';
import {
  toHalfWidth,
  toSimplified,
  extractTerms,
  normalize,
  expandSynonyms,
} from '../src/normalize.js';

describe('toHalfWidth', () => {
  it('folds fullwidth ASCII to halfwidth', () => {
    expect(toHalfWidth('ＡＢＣ１２３')).toBe('ABC123');
  });
  it('folds fullwidth punctuation', () => {
    expect(toHalfWidth('！（）？')).toBe('!()?');
  });
  it('folds ideographic space', () => {
    expect(toHalfWidth('a\u3000b')).toBe('a b');
  });
  it('leaves CJK ideographs untouched', () => {
    expect(toHalfWidth('中文测试')).toBe('中文测试');
  });
});

describe('toSimplified', () => {
  it('folds common traditional chars', () => {
    expect(toSimplified('啟動記憶')).toBe('启动记忆');
    expect(toSimplified('部署端口')).toBe('部署端口');
    expect(toSimplified('測試環境')).toBe('测试环境');
  });
  it('passes simplified text through unchanged', () => {
    expect(toSimplified('已经简体')).toBe('已经简体');
  });
  it('leaves ASCII untouched', () => {
    expect(toSimplified('port 8080')).toBe('port 8080');
  });
});

describe('extractTerms', () => {
  it('extracts ASCII words and numbers', () => {
    expect(extractTerms('port 8080 react-vue')).toEqual(
      expect.arrayContaining(['port', '8080', 'react-vue']),
    );
  });
  it('extracts CJK bigrams', () => {
    expect(extractTerms('部署端口')).toEqual(expect.arrayContaining(['部署', '署端', '端口']));
  });
  it('keeps single CJK char when run is length 1', () => {
    expect(extractTerms('端')).toEqual(['端']);
  });
});

describe('normalize pipeline', () => {
  it('composes simplified + halfwidth + lowercase', () => {
    const n = normalize('ＤＥＰＬＯＹ啟動');
    expect(n.text).toBe('deploy启动');
    expect(n.terms).toEqual(expect.arrayContaining(['deploy', '启动']));
  });
});

describe('expandSynonyms', () => {
  const groups = [
    ['端口', '接口'],
    ['启动', '拉起'],
  ];
  it('expands a hit token to the whole group', () => {
    const out = expandSynonyms('端口', groups);
    expect(out).toEqual(expect.arrayContaining(['端口', '接口']));
  });
  it('expands via bigram containment of base terms', () => {
    const out = expandSynonyms('部署端口是多少', groups);
    // 端口 bigram is in base terms → group expanded
    expect(out).toEqual(expect.arrayContaining(['端口', '接口']));
  });
  it('does not expand unrelated groups', () => {
    const out = expandSynonyms('内存泄漏', groups);
    expect(out).not.toContain('接口');
  });
});
