import { describe, mock, test } from 'bun:test';
import { mockClient } from 'aws-sdk-client-mock';

mock.module('pg', () => ({ Pool: class {} }));

describe('fixture', () => {
  test('usa mock', () => {
    mockClient;
  });
});
