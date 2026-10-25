'use strict';

// A deterministic unit-test double, never evidence of real MongoDB integration.
function memoryDb() {
  const tables = new Map();
  const indexes = new Map();
  const clone = value => value === undefined ? undefined : structuredClone(value);
  const matches = (row, query) => Object.entries(query).every(([key, value]) => {
    if (value && typeof value === 'object' && '$in' in value) return value.$in.includes(row[key]);
    return row[key] === value;
  });
  return {
    tables, indexes,
    collection(name) {
      if (!tables.has(name)) tables.set(name, []);
      if (!indexes.has(name)) indexes.set(name, []);
      const rows = tables.get(name);
      const unique = value => {
        for (const fields of [['_id'], ...indexes.get(name).filter(item => item.options.unique).map(item => Object.keys(item.keys))]) {
          if (fields.some(key => value[key] === undefined)) continue;
          if (rows.some(row => fields.every(key => row[key] === value[key]))) {
            throw Object.assign(Error('duplicate'), { code: 11000 });
          }
        }
      };
      function update(row, patch, inserting = false) {
        if (inserting) Object.assign(row, clone(patch.$setOnInsert || {}));
        Object.assign(row, clone(patch.$set || {}));
        for (const [key, amount] of Object.entries(patch.$inc || {})) row[key] = (row[key] || 0) + amount;
        for (const key of Object.keys(patch.$unset || {})) delete row[key];
      }
      return {
        async createIndex(keys, options = {}) { indexes.get(name).push({ keys, options }); },
        async insertOne(value) { unique(value); rows.push(clone(value)); return { acknowledged: true }; },
        async findOne(query) { return clone(rows.find(row => matches(row, query))); },
        find(query) {
          let selected = rows.filter(row => matches(row, query));
          const cursor = {
            sort(spec) {
              const [field, direction] = Object.entries(spec)[0];
              selected.sort((a, b) => direction * (a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0));
              return cursor;
            },
            limit(limit) { selected = selected.slice(0, limit); return cursor; },
            async toArray() { return clone(selected); }
          };
          return cursor;
        },
        async updateOne(query, patch, options = {}) {
          let row = rows.find(row => matches(row, query));
          if (!row && options.upsert) {
            row = clone(query); update(row, patch, true); unique(row); rows.push(row);
            return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
          }
          if (!row) return { matchedCount: 0, modifiedCount: 0 };
          update(row, patch);
          return { matchedCount: 1, modifiedCount: 1 };
        },
        async findOneAndUpdate(query, patch, options = {}) {
          let row = rows.find(row => matches(row, query));
          if (!row && options.upsert) {
            row = clone(query); update(row, patch, true); unique(row); rows.push(row);
          } else if (row) update(row, patch);
          return clone(row);
        },
        async deleteOne(query) {
          const index = rows.findIndex(row => matches(row, query));
          if (index < 0) return { deletedCount: 0 };
          rows.splice(index, 1); return { deletedCount: 1 };
        },
        async deleteMany(query) {
          let deletedCount = 0;
          for (let index = rows.length - 1; index >= 0; index--) {
            if (matches(rows[index], query)) { rows.splice(index, 1); deletedCount++; }
          }
          return { deletedCount };
        }
      };
    }
  };
}
module.exports = { memoryDb };
