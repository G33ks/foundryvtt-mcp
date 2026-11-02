/**
 * @fileoverview Tests for the checks `init` runs.
 */

import { describe, expect, it } from 'vitest';
import { NoActiveWorldError } from '../../foundry/auth.js';
import {
  BRIDGE_MANIFEST_URL,
  describeLoginError,
  describeNetworkError,
  evaluateModule,
  evaluateRole,
  normalizeUrl,
  probeJoin,
} from '../checks.js';

describe('normalizeUrl', () => {
  it.each([
    ['https://foundry.example.com/', 'https://foundry.example.com'],
    ['  https://179.237.108.197  ', 'https://179.237.108.197'],
    ['https://foundry.example.com/join', 'https://foundry.example.com'],
    ['https://example.com/vtt/game', 'https://example.com/vtt'],
    ['foundry.example.com', 'https://foundry.example.com'],
    ['localhost:30000', 'http://localhost:30000'],
    ['127.0.0.1:30000/setup', 'http://127.0.0.1:30000'],
    ['HTTP://LOCALHOST:30000', 'http://localhost:30000'],
  ])('%s → %s', (input, expected) => {
    const result = normalizeUrl(input);
    expect(result.ok && result.value).toBe(expected);
  });

  it('refuses empty, invalid and non-http addresses', () => {
    expect(normalizeUrl('').ok).toBe(false);
    expect(normalizeUrl('https://exa mple.com').ok).toBe(false);
    expect(normalizeUrl('ftp://example.com').ok).toBe(false);
  });

  it('warns about plain http to a remote host only', () => {
    const remote = normalizeUrl('http://foundry.example.com');
    expect(remote.ok && remote.warning).toMatch(/unencrypted/);
    const local = normalizeUrl('http://localhost:30000');
    expect(local.ok && local.warning).toBeFalsy();
  });
});

describe('describeNetworkError', () => {
  const url = 'https://179.237.108.197';

  it('names TLS problems and how to fix them', () => {
    const error = Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' });
    const message = describeNetworkError(url, error);
    expect(message).toContain('its certificate has expired (CERT_HAS_EXPIRED)');
    expect(message).toContain('NODE_EXTRA_CA_CERTS');
  });

  it('finds the code on a wrapped cause', () => {
    const error = Object.assign(new Error('x'), {
      code: 'ERR_BAD_RESPONSE',
      cause: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' },
    });
    expect(describeNetworkError(url, error)).toContain('self-signed');
  });

  it('explains unreachable hosts', () => {
    const notFound = Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' });
    expect(describeNetworkError('https://foudnry.example.com', notFound)).toMatch(
      /foudnry\.example\.com could not be found .*spelling/,
    );
    const refused = Object.assign(new Error('connect'), { code: 'ECONNREFUSED' });
    expect(describeNetworkError(url, refused)).toMatch(/refused the connection/);
  });
});

describe('probeJoin', () => {
  const url = 'https://foundry.example.com';
  const session = { 'set-cookie': ['session=abc; Path=/; HttpOnly'] };

  it('accepts a join page with a session cookie', async () => {
    const result = await probeJoin(url, async () => ({
      status: 200,
      headers: session,
      data: '<html>',
    }));
    expect(result.ok).toBe(true);
  });

  it('recognizes the "No Active Game" page', async () => {
    const result = await probeJoin(url, async () => ({
      status: 200,
      headers: session,
      data: '<title>Foundry Virtual Tabletop • No Active Game</title>',
    }));
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/No Active Game/) });
  });

  it('recognizes a redirect to the Setup screen', async () => {
    const result = await probeJoin(url, async () => ({
      status: 302,
      headers: { location: '/setup' },
      data: '',
    }));
    expect(result).toMatchObject({
      ok: false,
      message: expect.stringMatching(/no world is running/),
    });
  });

  it('says when the answer is not FoundryVTT', async () => {
    const result = await probeJoin(url, async () => ({ status: 404, headers: {}, data: 'nope' }));
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/HTTP 404/) });
  });

  it('reports network errors', async () => {
    const result = await probeJoin(url, async () => {
      throw Object.assign(new Error('x'), { code: 'ECONNREFUSED' });
    });
    expect(result).toMatchObject({
      ok: false,
      message: expect.stringMatching(/refused the connection/),
    });
  });
});

describe('describeLoginError', () => {
  const url = 'https://foundry.example.com';

  it('asks for the account again on a wrong password', () => {
    const error = new Error(
      'FoundryVTT authentication failed (HTTP 401): JOIN.ErrorInvalidPassword',
    );
    expect(describeLoginError(url, 'mcp-api', error)).toEqual({
      message: 'Wrong password for "mcp-api".',
      retry: 'account',
    });
  });

  it('asks for the account again on an unknown user', () => {
    const result = describeLoginError(url, 'mcp-apu', new Error('User "mcp-apu" not found'));
    expect(result.retry).toBe('account');
    expect(result.message).toContain('no user named "mcp-apu"');
  });

  it('waits for the world when none is running', () => {
    expect(describeLoginError(url, 'mcp-api', new NoActiveWorldError()).retry).toBe('world');
  });

  it('sends network failures back to the address', () => {
    const error = Object.assign(new Error('x'), { code: 'ETIMEDOUT' });
    expect(describeLoginError(url, 'mcp-api', error).retry).toBe('url');
  });
});

describe('evaluateRole', () => {
  it('refuses roles below Assistant GM', () => {
    for (const role of [0, 1, 2]) {
      const verdict = evaluateRole('mcp-api', role);
      expect(verdict.ok).toBe(false);
      expect(verdict.message).toMatch(/Assistant GM/);
    }
  });

  it('accepts an Assistant GM without warning', () => {
    expect(evaluateRole('mcp-api', 3)).toEqual({
      ok: true,
      value: undefined,
      message: 'Logged in as "mcp-api" (Assistant GM).',
    });
  });

  it('accepts a Gamemaster with the phase 1 warning', () => {
    const verdict = evaluateRole('mcp-api', 4);
    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.warning).toMatch(/Make this account an Assistant GM/);
  });
});

describe('evaluateModule', () => {
  it('gives the manifest URL when the module is missing', () => {
    const verdict = evaluateModule([{ id: 'other', active: true }]);
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain(BRIDGE_MANIFEST_URL);
    expect(verdict.message).toContain('Install Module');
  });

  it('explains how to enable an installed but inactive module', () => {
    const verdict = evaluateModule([
      { id: 'foundryvtt-mcp-bridge', version: '0.5.1', active: false },
    ]);
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('v0.5.1 is installed but not enabled');
    expect(verdict.message).toContain('Manage Modules');
  });

  it('reports the version of an enabled module', () => {
    expect(
      evaluateModule([{ id: 'foundryvtt-mcp-bridge', version: '0.5.1', active: true }]),
    ).toEqual({
      ok: true,
      value: '0.5.1',
      message: 'Companion module foundryvtt-mcp-bridge v0.5.1 installed and enabled.',
    });
  });
});
