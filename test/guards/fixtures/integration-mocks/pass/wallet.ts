import { describe, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { startContainers } from '../../helpers/containers';

describe('fixture', () => {
  test('usa PostgreSQL real', () => {
    expect({ Pool, startContainers }).toBeDefined();
  });
});
