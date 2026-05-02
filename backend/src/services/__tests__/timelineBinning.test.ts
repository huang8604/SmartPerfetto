// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, it, expect} from '@jest/globals';
import {binTimelineSamples, encodeCounterRle} from '../timelineBinning';
import {isUnsupported} from '../../types/sparkContracts';

describe('binTimelineSamples', () => {
  it('aggregates samples into uniform bins with rowCount metadata', () => {
    const samples = [
      {ts: 0, value: 100},
      {ts: 25, value: 200},
      {ts: 60, value: 50},
    ];
    const contract = binTimelineSamples({
      trackId: 'cpu0',
      samples,
      range: {startNs: 0, endNs: 100},
      binDurNs: 50,
      aggregation: 'avg',
    });
    expect(contract.bins).toBeDefined();
    expect(contract.bins).toHaveLength(2);
    const bins = contract.bins;
    if (bins) {
      expect(bins[0].rowCount).toBe(2);
      expect(bins[0].value).toBe(150);
      expect(bins[1].rowCount).toBe(1);
      expect(bins[1].value).toBe(50);
    }
  });

  it('drops samples outside the range', () => {
    const contract = binTimelineSamples({
      trackId: 'x',
      samples: [
        {ts: -10, value: 1},
        {ts: 5, value: 5},
        {ts: 200, value: 99},
      ],
      range: {startNs: 0, endNs: 100},
      binDurNs: 50,
    });
    if (contract.bins) {
      const total = contract.bins.reduce((s, b) => s + (b.rowCount ?? 0), 0);
      expect(total).toBe(1);
    }
  });

  it('marks unsupported when bin width is non-positive', () => {
    const contract = binTimelineSamples({
      trackId: 'bad',
      samples: [],
      range: {startNs: 0, endNs: 100},
      binDurNs: 0,
    });
    expect(isUnsupported(contract)).toBe(true);
  });
});

describe('encodeCounterRle', () => {
  it('collapses adjacent equal-value samples and records deltas', () => {
    const samples = [
      {ts: 0, value: 50},
      {ts: 100, value: 50},
      {ts: 200, value: 80},
      {ts: 300, value: 80},
      {ts: 400, value: 60},
    ];
    const contract = encodeCounterRle({
      trackId: 'gpu_freq',
      samples,
      range: {startNs: 0, endNs: 500},
    });
    expect(contract.rle).toBeDefined();
    const rle = contract.rle;
    if (rle) {
      expect(rle.length).toBe(3);
      expect(rle[0].value).toBe(50);
      expect(rle[1].value).toBe(80);
      expect(rle[1].delta).toBe(30);
      expect(rle[2].value).toBe(60);
      expect(rle[2].delta).toBe(-20);
    }
  });
});
