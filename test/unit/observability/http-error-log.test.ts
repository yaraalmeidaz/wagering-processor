import { describe, expect, test } from 'bun:test';
import type { ArgumentsHost } from '@nestjs/common';
import { HttpErrorFilter } from '../../../src/interfaces/http/http-error.filter';
import { FakeClock } from '../../helpers/clock';

function hostCapturing(sent: { status?: number; body?: unknown; headers: Record<string, string> }) {
  const response = {
    setHeader: (name: string, value: string) => {
      sent.headers[name] = value;
    },
    status: (code: number) => {
      sent.status = code;
      return {
        json: (body: unknown) => {
          sent.body = body;
        },
      };
    },
  };
  return { switchToHttp: () => ({ getResponse: () => response }) } as unknown as ArgumentsHost;
}

// ADR-0011; SPEC 14.1. O mapeamento de status continua o da ADR-0009.
describe('HttpErrorFilter: log do erro inesperado', () => {
  test('erro desconhecido responde 503 e escreve uma linha JSON só com o nome do erro', () => {
    const lines: string[] = [];
    const filter = new HttpErrorFilter(
      { write: (line) => lines.push(line) },
      new FakeClock(new Date('2026-11-16T12:00:00Z')),
    );
    const sent: { status?: number; body?: unknown; headers: Record<string, string> } = {
      headers: {},
    };
    class SurpriseError extends Error {
      override name = 'SurpriseError';
    }

    filter.catch(new SurpriseError('detalhe com amount 25.00'), hostCapturing(sent));

    expect(sent.status).toBe(503);
    expect(sent.headers['Retry-After']).toBe('1');
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      {
        timestamp: '2026-11-16T12:00:00.000Z',
        level: 'error',
        event: 'http_unexpected_error',
        error: 'SurpriseError',
      },
    ]);
  });
});
