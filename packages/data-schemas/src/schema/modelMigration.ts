import { Schema } from 'mongoose';

/**
 * Fork: the model migration that last rewrote an agent or conversation (`methods/modelMigration.ts`),
 * kept until the owner has seen the notice "Now runs on X instead of Y".
 */
export interface ModelMigrationNotice {
  /** The migration (redirect) id. */
  id: string;
  from: { endpoint: string; model: string };
  to: { endpoint: string; model: string };
  at: Date;
}

const modelRefSchema = new Schema(
  {
    endpoint: { type: String, required: true },
    model: { type: String, required: true },
  },
  { _id: false },
);

export const modelMigrationNoticeSchema: Schema<ModelMigrationNotice> =
  new Schema<ModelMigrationNotice>(
    {
      id: { type: String, required: true },
      from: { type: modelRefSchema, required: true },
      to: { type: modelRefSchema, required: true },
      at: { type: Date, required: true },
    },
    { _id: false },
  );
