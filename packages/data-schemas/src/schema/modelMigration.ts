import { Schema } from 'mongoose';

/**
 * Fork: the model migration that last rewrote an agent or conversation (`methods/modelMigration.ts`),
 * kept until the owner has seen the notice "Now runs on X instead of Y".
 */
export interface ModelMigrationNotice {
  /** The migration (redirect) id. */
  id: string;
  /** `label` is the display name at migration time, when one was known. */
  from: { endpoint: string; model: string; label?: string };
  to: { endpoint: string; model: string; label?: string };
  at: Date;
}

const modelRefSchema = new Schema(
  {
    endpoint: { type: String, required: true },
    model: { type: String, required: true },
    label: { type: String },
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
