import { Injectable } from '@nestjs/common';
import { Money } from './money';
import { Pool } from 'pg';
import { ProcessWager } from '../../application/process-wager';

export const walletFixture = { Injectable, Money, Pool, ProcessWager };
