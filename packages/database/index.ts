import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const globalForDb = globalThis as unknown as { pool: Pool | undefined };

const pool = globalForDb.pool ?? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

if (process.env.NODE_ENV !== "production") {
  globalForDb.pool = pool;
}

const drizzleDb = drizzle(pool, { schema });

// ─── Local JSON Fallback Database ───────────────────────────────────────────
const FALLBACK_FILE = path.join(process.cwd(), 'db_fallback.json');

function loadFallbackData() {
  if (!fs.existsSync(FALLBACK_FILE)) {
    const initial = { users: [], proposals: [], votes: [] };
    fs.writeFileSync(FALLBACK_FILE, JSON.stringify(initial, null, 2), 'utf-8');
    return initial;
  }
  try {
    const content = fs.readFileSync(FALLBACK_FILE, 'utf-8');
    return JSON.parse(content);
  } catch (e) {
    const initial = { users: [], proposals: [], votes: [] };
    return initial;
  }
}

function saveFallbackData(data: any) {
  try {
    fs.writeFileSync(FALLBACK_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) {
    console.error("Failed to save fallback database:", e);
  }
}

function parseCondition(condition: any) {
  if (!condition || !condition.queryChunks) return null;
  let column: any = null;
  let param: any = null;
  for (const chunk of condition.queryChunks) {
    if (chunk && chunk.table && chunk.name) {
      column = chunk.name;
    } else if (chunk && 'value' in chunk && !Array.isArray(chunk.value)) {
      param = chunk.value;
    }
  }
  if (column && param !== undefined) {
    return { column, value: param };
  }
  return null;
}

function executeFallbackQuery(commandType: string, commandArgs: any[], chain: any[]): any {
  let tableName = '';
  if (commandType === 'select') {
    const fromStep = chain.find((c: any) => c.prop === 'from');
    if (fromStep && fromStep.args[0]) {
      tableName = fromStep.args[0]._?.name || fromStep.args[0][Symbol.for('drizzle:Name')];
    }
  } else if (commandType === 'update' || commandType === 'insert' || commandType === 'delete') {
    if (commandArgs[0]) {
      tableName = commandArgs[0]._?.name || commandArgs[0][Symbol.for('drizzle:Name')];
    }
  }

  if (!tableName) {
    throw new Error(`Fallback DB: Could not determine table name for command ${commandType}`);
  }

  const whereStep = chain.find((c: any) => c.prop === 'where');
  const condition = whereStep ? whereStep.args[0] : null;
  const filter = parseCondition(condition);

  const data = loadFallbackData();
  if (!data[tableName]) {
    data[tableName] = [];
  }

  if (commandType === 'select') {
    let records = [...data[tableName]];
    if (filter) {
      records = records.filter((r: any) => String(r[filter.column]) === String(filter.value));
    }
    const limitStep = chain.find((c: any) => c.prop === 'limit');
    if (limitStep && limitStep.args[0] !== undefined) {
      records = records.slice(0, limitStep.args[0]);
    }
    return records;
  }

  if (commandType === 'insert') {
    const valuesStep = chain.find((c: any) => c.prop === 'values');
    const valuesToInsert = valuesStep ? valuesStep.args[0] : null;
    let insertedRecords: any[] = [];
    if (valuesToInsert) {
      const recordsArray = Array.isArray(valuesToInsert) ? valuesToInsert : [valuesToInsert];
      for (const item of recordsArray) {
        const copy = { ...item };
        if (tableName === 'users' && !copy.user_id) {
          copy.user_id = crypto.randomUUID();
        }
        if (tableName === 'proposals' && !copy.id) {
          copy.id = crypto.randomUUID();
        }
        if (tableName === 'votes' && !copy.id) {
          copy.id = crypto.randomUUID();
        }
        if (tableName === 'cc_linked_accounts' && !copy.id) {
          copy.id = crypto.randomUUID();
        }
        if (!copy.created_at) {
          copy.created_at = new Date().toISOString();
        }
        if (!copy.updated_at && tableName === 'cc_linked_accounts') {
          copy.updated_at = new Date().toISOString();
        }
        // Enforce uniqueness constraints locally (e.g. proposal_voter_idx)
        if (tableName === 'votes') {
          data.votes = data.votes.filter((v: any) => !(v.proposal_id === copy.proposal_id && v.voter_wallet === copy.voter_wallet));
        }
        data[tableName].push(copy);
        insertedRecords.push(copy);
      }
      saveFallbackData(data);
    }
    return insertedRecords;
  }

  if (commandType === 'update') {
    const setStep = chain.find((c: any) => c.prop === 'set');
    const setValues = setStep ? setStep.args[0] : null;
    let updatedRecords: any[] = [];
    if (setValues) {
      const records = data[tableName];
      for (let i = 0; i < records.length; i++) {
        const r = records[i];
        let match = true;
        if (filter) {
          match = String(r[filter.column]) === String(filter.value);
        }
        if (match) {
          const updated = { ...r };
          for (const [k, v] of Object.entries(setValues)) {
            if (v && typeof v === 'object' && 'sql' in (v as any || {})) {
              if (k === 'roasts_count') {
                updated[k] = (updated[k] || 0) + 1;
              } else if (k === 'persuasion_attempts') {
                updated[k] = (updated[k] || 0) + 1;
              }
            } else {
              updated[k] = v;
            }
          }
          records[i] = updated;
          updatedRecords.push(updated);
        }
      }
      data[tableName] = records;
      saveFallbackData(data);
    }
    return updatedRecords;
  }

  if (commandType === 'delete') {
    let deletedRecords: any[] = [];
    const records = data[tableName];
    const remaining: any[] = [];
    for (const r of records) {
      let match = true;
      if (filter) {
        match = String(r[filter.column]) === String(filter.value);
      }
      if (match) {
        deletedRecords.push(r);
      } else {
        remaining.push(r);
      }
    }
    data[tableName] = remaining;
    saveFallbackData(data);
    return deletedRecords;
  }

  return null;
}

function wrapQuery(queryObj: any, commandType: string, commandArgs: any[], chain: any[] = []): any {
  return new Proxy(queryObj, {
    get(target, prop, receiver) {
      if (prop === 'then') {
        return function(resolve: any, reject: any) {
          return target.then(
            (res: any) => resolve(res),
            (err: any) => {
              console.warn(`[DATABASE WARNING] Real database query failed: ${err.message}. Falling back to local JSON database.`);
              try {
                const fallbackResult = executeFallbackQuery(commandType, commandArgs, chain);
                resolve(fallbackResult);
              } catch (fallbackErr) {
                reject(fallbackErr);
              }
            }
          );
        };
      }
      const val = Reflect.get(target, prop, receiver);
      if (typeof val === 'function') {
        return function(...args: any[]) {
          const nextQuery = val.apply(target, args);
          return wrapQuery(nextQuery, commandType, commandArgs, [...chain, { prop, args }]);
        };
      }
      return val;
    }
  });
}

export const db = new Proxy(drizzleDb, {
  get(target, prop, receiver) {
    const orig = Reflect.get(target, prop, receiver);
    if (typeof orig === 'function' && ['select', 'insert', 'update', 'delete'].includes(prop as string)) {
      return function(...args: any[]) {
        const queryObj = orig.apply(target, args);
        return wrapQuery(queryObj, prop as string, args);
      };
    }
    return orig;
  }
}) as any;

export * from './schema';

