#!/usr/bin/env bash
# Cria as filas SQS FIFO da seção 10.1 do docs/SPEC.md.
# Executado pelo LocalStack em /etc/localstack/init/ready.d/. Idempotente.
set -euo pipefail

INPUT_QUEUE="wager-transactions.fifo"
DLQ_QUEUE="wager-transactions-dlq.fifo"
EVENTS_QUEUE="wager-events.fifo"
# Precisa ser igual a MAX_RECEIVE_COUNT de src/infrastructure/messaging/queues.ts, assim como
# os nomes das filas. test/unit/messaging/queue-setup.test.ts compara os dois.
MAX_RECEIVE_COUNT=5 # RN-35

awslocal sqs create-queue --queue-name "$DLQ_QUEUE" --attributes FifoQueue=true >/dev/null

dlq_url="$(awslocal sqs get-queue-url --queue-name "$DLQ_QUEUE" --query QueueUrl --output text)"
dlq_arn="$(awslocal sqs get-queue-attributes --queue-url "$dlq_url" \
  --attribute-names QueueArn --query Attributes.QueueArn --output text)"

attributes_file="$(mktemp)"
trap 'rm -f "$attributes_file"' EXIT
cat >"$attributes_file" <<JSON
{
  "FifoQueue": "true",
  "RedrivePolicy": "{\"deadLetterTargetArn\":\"${dlq_arn}\",\"maxReceiveCount\":\"${MAX_RECEIVE_COUNT}\"}"
}
JSON
awslocal sqs create-queue --queue-name "$INPUT_QUEUE" --attributes "file://${attributes_file}" >/dev/null

awslocal sqs create-queue --queue-name "$EVENTS_QUEUE" --attributes FifoQueue=true >/dev/null

echo "create-queues: ${DLQ_QUEUE}, ${INPUT_QUEUE}, ${EVENTS_QUEUE} prontas"
