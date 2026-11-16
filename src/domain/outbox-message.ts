import { InvalidOutboxMessageError } from './errors';
import { RETRY_ATTEMPT_LIMIT, retryDelayMs } from './retry-backoff';

export interface OutboxMessageState {
  /** É o eventId do envelope (SPEC 11.2; ADR-0006). */
  readonly id: string;
  /** walletId da carteira afetada (ADR-0006). */
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
  readonly attempts: number;
  readonly nextAttemptAt: Date;
  readonly publishedAt: Date | null;
}

export type OutboxEnqueueInput = Pick<
  OutboxMessageState,
  'id' | 'aggregateId' | 'eventType' | 'payload' | 'occurredAt'
>;

/**
 * Evento à espera de publicação (SPEC 3.5 e 11.3). A ordem entre
 * eventos é do banco (seq), não da entidade (ADR-0006).
 */
export class OutboxMessage {
  readonly id: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly #occurredAt: Date;
  #attempts: number;
  #nextAttemptAt: Date;
  #publishedAt: Date | null;

  private constructor(state: OutboxMessageState) {
    this.id = state.id;
    this.aggregateId = state.aggregateId;
    this.eventType = state.eventType;
    this.payload = state.payload;
    this.#occurredAt = new Date(state.occurredAt);
    this.#attempts = state.attempts;
    this.#nextAttemptAt = new Date(state.nextAttemptAt);
    this.#publishedAt = state.publishedAt === null ? null : new Date(state.publishedAt);
  }

  /** Valida e cria. */
  static create(state: OutboxMessageState): OutboxMessage {
    if (state.id.trim() === '') throw new InvalidOutboxMessageError('id é obrigatório');
    if (state.aggregateId.trim() === '') {
      throw new InvalidOutboxMessageError('aggregateId é obrigatório');
    }
    if (state.eventType.trim() === '') {
      throw new InvalidOutboxMessageError('eventType é obrigatório');
    }
    if (!Number.isInteger(state.attempts) || state.attempts < 0) {
      throw new InvalidOutboxMessageError('attempts precisa ser inteiro >= 0');
    }
    return new OutboxMessage(state);
  }

  /** Evento novo: pendente, sem tentativas, devido a partir de quando ocorreu. */
  static enqueue(input: OutboxEnqueueInput): OutboxMessage {
    return OutboxMessage.create({
      ...input,
      attempts: 0,
      nextAttemptAt: input.occurredAt,
      publishedAt: null,
    });
  }

  /** Reconstrói o estado persistido, sem revalidar (SPEC 2.1). */
  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(state);
  }

  get occurredAt(): Date {
    return new Date(this.#occurredAt);
  }

  get attempts(): number {
    return this.#attempts;
  }

  get nextAttemptAt(): Date {
    return new Date(this.#nextAttemptAt);
  }

  get publishedAt(): Date | null {
    return this.#publishedAt === null ? null : new Date(this.#publishedAt);
  }

  isPending(): boolean {
    return this.#publishedAt === null;
  }

  isDue(now: Date): boolean {
    return this.isPending() && this.#nextAttemptAt.getTime() <= now.getTime();
  }

  /** Falha no envio: nova tentativa com o backoff da ADR-0007 (ADR-0006). */
  scheduleRetry(now: Date, random: () => number): void {
    this.#assertPending();
    this.#attempts += 1;
    this.#nextAttemptAt = new Date(now.getTime() + retryDelayMs(this.#attempts, random));
  }

  /** 12 falhas ou mais: segue tentando no teto, mas pede intervenção (ADR-0006). */
  isRetryExhausted(): boolean {
    return this.#attempts >= RETRY_ATTEMPT_LIMIT;
  }

  /** Só depois do ack do SQS (SPEC 11.3, passo 2d). */
  markPublished(now: Date): void {
    this.#assertPending();
    this.#publishedAt = new Date(now);
  }

  #assertPending(): void {
    if (this.#publishedAt !== null) {
      throw new InvalidOutboxMessageError(`evento ${this.id} já publicado`);
    }
  }
}
