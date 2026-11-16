import { InvalidInboxMessageError } from './errors';

export interface InboxMessageState {
  readonly consumerName: string;
  readonly messageId: string;
  /** SHA-256 em hex do corpo da mensagem (ADR-0010). */
  readonly payloadHash: string;
  readonly receivedAt: Date;
  readonly processedAt: Date | null;
}

const PAYLOAD_HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Mensagem recebida da fila, deduplicada por (consumerName, messageId)
 * (SPEC 3.5 e 10.2). Gravada na transação do efeito (ADR-0010).
 */
export class InboxMessage {
  readonly consumerName: string;
  readonly messageId: string;
  readonly payloadHash: string;
  readonly #receivedAt: Date;
  #processedAt: Date | null;

  private constructor(state: InboxMessageState) {
    this.consumerName = state.consumerName;
    this.messageId = state.messageId;
    this.payloadHash = state.payloadHash;
    this.#receivedAt = new Date(state.receivedAt);
    this.#processedAt = state.processedAt === null ? null : new Date(state.processedAt);
  }

  /** Valida e cria. */
  static create(state: InboxMessageState): InboxMessage {
    if (state.consumerName.trim() === '') {
      throw new InvalidInboxMessageError('consumerName é obrigatório');
    }
    if (state.messageId.trim() === '') {
      throw new InvalidInboxMessageError('messageId é obrigatório');
    }
    if (!PAYLOAD_HASH_PATTERN.test(state.payloadHash)) {
      throw new InvalidInboxMessageError('payloadHash precisa ser SHA-256 em hex');
    }
    return new InboxMessage(state);
  }

  /** Mensagem que acabou de chegar, ainda não processada. */
  static receive(input: {
    consumerName: string;
    messageId: string;
    payloadHash: string;
    now: Date;
  }): InboxMessage {
    return InboxMessage.create({
      consumerName: input.consumerName,
      messageId: input.messageId,
      payloadHash: input.payloadHash,
      receivedAt: input.now,
      processedAt: null,
    });
  }

  /** Reconstrói o estado persistido, sem revalidar (SPEC 2.1). */
  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(state);
  }

  get receivedAt(): Date {
    return new Date(this.#receivedAt);
  }

  get processedAt(): Date | null {
    return this.#processedAt === null ? null : new Date(this.#processedAt);
  }

  isProcessed(): boolean {
    return this.#processedAt !== null;
  }

  markProcessed(now: Date): void {
    if (this.#processedAt !== null) {
      throw new InvalidInboxMessageError(`mensagem ${this.messageId} já processada`);
    }
    if (now.getTime() < this.#receivedAt.getTime()) {
      throw new InvalidInboxMessageError('processedAt não pode ser anterior a receivedAt');
    }
    this.#processedAt = new Date(now);
  }

  /** Mesmo messageId com outro conteúdo não é duplicata comum (ADR-0010). */
  hasSamePayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }
}
