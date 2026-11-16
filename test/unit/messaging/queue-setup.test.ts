import { describe, expect, test } from 'bun:test';
import {
  DLQ_QUEUE,
  EVENTS_QUEUE,
  INPUT_QUEUE,
  MAX_RECEIVE_COUNT,
} from '../../../src/infrastructure/messaging/queues';

// SPEC 10.1; RN-35; ADR-0010: o script do LocalStack e o código usam os mesmos valores.
const SCRIPT = new URL('../../../scripts/localstack/create-queues.sh', import.meta.url);

/** Valor de uma atribuição VAR=valor (com ou sem aspas) no script. */
function assignment(script: string, name: string): string {
  const match = new RegExp(`^${name}="?([^"\\s]+)"?`, 'm').exec(script);
  if (match?.[1] === undefined) throw new Error(`${name} não encontrado em create-queues.sh`);
  return match[1];
}

describe('scripts/localstack/create-queues.sh e src/infrastructure/messaging/queues.ts', () => {
  test('maxReceiveCount do redrive é o mesmo (RN-35)', async () => {
    const script = await Bun.file(SCRIPT).text();
    expect(Number(assignment(script, 'MAX_RECEIVE_COUNT'))).toBe(MAX_RECEIVE_COUNT);
  });

  test('nomes das filas são os mesmos (SPEC 10.1)', async () => {
    const script = await Bun.file(SCRIPT).text();
    expect({
      input: assignment(script, 'INPUT_QUEUE'),
      dlq: assignment(script, 'DLQ_QUEUE'),
      events: assignment(script, 'EVENTS_QUEUE'),
    }).toEqual({ input: INPUT_QUEUE, dlq: DLQ_QUEUE, events: EVENTS_QUEUE });
  });
});
