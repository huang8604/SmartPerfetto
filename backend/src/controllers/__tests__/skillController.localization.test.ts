// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it, jest} from '@jest/globals';
import type {Request, Response} from 'express';
import SkillController from '../skillController';

function responseDouble() {
  const response = {
    status: jest.fn(),
    json: jest.fn(),
  };
  response.status.mockReturnValue(response);
  response.json.mockReturnValue(response);
  return response as typeof response & Response;
}

function request(
  outputLanguage: 'zh-CN' | 'en',
  overrides: Record<string, unknown> = {},
): Request {
  return {
    body: {outputLanguage},
    query: {},
    headers: {},
    params: {},
    ...overrides,
  } as unknown as Request;
}

describe('SkillController localization', () => {
  it('localizes validation errors from the explicit request language', async () => {
    const controller = new SkillController();
    const response = responseDouble();

    await controller.getSkillDetail(
      request('zh-CN'),
      response,
    );

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({
      error: '缺少 Skill ID',
      details: '必须提供 skillId',
    });

    response.status.mockClear();
    response.json.mockClear();
    await controller.executeSkill(
      request('en'),
      response,
    );

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({
      error: 'Missing Skill ID',
      details: 'skillId is required in URL parameters',
    });
  });

  it('localizes controller failures while preserving technical error details', async () => {
    const controller = new SkillController();
    const response = responseDouble();
    const adapter = {
      listSkills: jest.fn<() => Promise<never>>()
        .mockRejectedValue(new Error('registry unavailable')),
    };
    (controller as unknown as {adapter: typeof adapter}).adapter = adapter;

    await controller.listSkills(
      request('zh-CN'),
      response,
    );

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith({
      error: '无法列出 Skills',
      details: 'registry unavailable',
    });
  });

  it('localizes unknown failure details instead of falling back to English', async () => {
    const controller = new SkillController();
    const response = responseDouble();
    const adapter = {
      listSkills: jest.fn<() => Promise<never>>()
        .mockRejectedValue({reason: 'offline'}),
    };
    (controller as unknown as {adapter: typeof adapter}).adapter = adapter;

    await controller.listSkills(
      request('zh-CN'),
      response,
    );

    expect(response.json).toHaveBeenCalledWith({
      error: '无法列出 Skills',
      details: '未知错误',
    });
  });
});
