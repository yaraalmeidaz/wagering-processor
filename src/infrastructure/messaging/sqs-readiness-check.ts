import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { DependencyCheck, DependencyStatus } from '../../application/ports/readiness-check';

/** Readiness do SQS: GetQueueAttributes na fila de entrada (ADR-0010). */
export class SqsReadinessCheck implements DependencyCheck {
  readonly #sqs: SQSClient;
  readonly #queueUrl: string;

  constructor(sqs: SQSClient, queueUrl: string) {
    this.#sqs = sqs;
    this.#queueUrl = queueUrl;
  }

  async check(): Promise<DependencyStatus> {
    try {
      await this.#sqs.send(
        new GetQueueAttributesCommand({ QueueUrl: this.#queueUrl, AttributeNames: ['QueueArn'] }),
      );
      return 'ok';
    } catch {
      return 'fail';
    }
  }
}
