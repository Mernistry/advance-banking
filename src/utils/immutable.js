function blockModification() {
  throw new Error('This collection is append-only: entries cannot be modified or deleted');
}

// Makes a schema append-only (used for the ledger and the audit log).
// Note: raw driver calls / bulkWrite bypass Mongoose hooks, so also restrict
// database user permissions in production (insert + find only).
export const makeImmutable = (schema) => {
  [
    'updateOne', 'updateMany', 'replaceOne',
    'findOneAndUpdate', 'findOneAndReplace', 'findOneAndDelete',
    'deleteOne', 'deleteMany',
  ].forEach((op) => schema.pre(op, blockModification));

  schema.pre('deleteOne', { document: true, query: false }, blockModification);
  schema.pre('save', function () {
    if (!this.isNew) blockModification();
  });
};
