import { describe, expect, it } from 'vitest';
import { clampPage, pageCountFromOffset, pageOfOffset, pageToProgress, progressToPage } from './Paginator';

describe('paginator math', () => {
  const stride = 400 + 40;

  it('counts pages from the end marker offset', () => {
    expect(pageCountFromOffset(0, stride)).toBe(1);
    expect(pageCountFromOffset(120, stride)).toBe(1);
    expect(pageCountFromOffset(stride, stride)).toBe(2);
    expect(pageCountFromOffset(stride * 4 - 0.5, stride)).toBe(5); // rounding error just before column 4
    expect(pageCountFromOffset(stride * 4 + 100, stride)).toBe(5);
    expect(pageCountFromOffset(100, 0)).toBe(1);
  });

  it('finds the page of an offset', () => {
    expect(pageOfOffset(0, stride, 10)).toBe(0);
    expect(pageOfOffset(stride * 3 + 5, stride, 10)).toBe(3);
    expect(pageOfOffset(stride * 30, stride, 10)).toBe(9);
    expect(pageOfOffset(-50, stride, 10)).toBe(0);
  });

  it('converts between page and progress', () => {
    expect(pageToProgress(0, 1)).toBe(1);
    expect(pageToProgress(0, 11)).toBe(0);
    expect(pageToProgress(5, 11)).toBe(0.5);
    expect(pageToProgress(10, 11)).toBe(1);
    expect(progressToPage(0.5, 11)).toBe(5);
    expect(progressToPage(1, 11)).toBe(10);
    expect(progressToPage(2, 11)).toBe(10);
    expect(progressToPage(0.3, 1)).toBe(0);
    expect(progressToPage(Number.NaN, 5)).toBe(0);
  });

  it('round-trips progress through pages', () => {
    for (let pages = 2; pages < 40; pages++) {
      for (let p = 0; p < pages; p++) expect(progressToPage(pageToProgress(p, pages), pages)).toBe(p);
    }
  });

  it('clamps pages', () => {
    expect(clampPage(-1, 5)).toBe(0);
    expect(clampPage(7, 5)).toBe(4);
    expect(clampPage(2.4, 5)).toBe(2);
    expect(clampPage(3, 0)).toBe(0);
  });
});
