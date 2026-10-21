import { DataTypes, Model, type InferAttributes, type InferCreationAttributes } from 'sequelize';
import { sequelize } from './sequelize.js';

// Importes en BIGINT: mysql2 los devuelve como string (o number si caben); los repositorios los pasan por Number().

export class ReceivableModel extends Model<InferAttributes<ReceivableModel>, InferCreationAttributes<ReceivableModel>> {
  declare id: string;
  declare organization_id: string;
  declare customer_id: string;
  declare customer_name: string;
  declare customer_identification: string | null;
  declare source_type: string;
  declare source_id: string;
  declare document_number: string | null;
  declare issue_date: string;
  declare due_date: string;
  declare currency_code: string;
  declare original_cents: string | number;
  declare status: string;
  declare version: number;
  declare created_at: Date;
  declare updated_at: Date;
}

ReceivableModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    customer_id: { type: DataTypes.CHAR(36), allowNull: false },
    customer_name: { type: DataTypes.STRING(300), allowNull: false },
    customer_identification: { type: DataTypes.STRING(20), allowNull: true },
    source_type: { type: DataTypes.STRING(20), allowNull: false },
    source_id: { type: DataTypes.STRING(64), allowNull: false },
    document_number: { type: DataTypes.STRING(60), allowNull: true },
    issue_date: { type: DataTypes.DATEONLY, allowNull: false },
    due_date: { type: DataTypes.DATEONLY, allowNull: false },
    currency_code: { type: DataTypes.CHAR(3), allowNull: false },
    original_cents: { type: DataTypes.BIGINT, allowNull: false },
    status: { type: DataTypes.STRING(20), allowNull: false },
    version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'receivables', timestamps: false },
);

export class CreditApplicationModel extends Model<InferAttributes<CreditApplicationModel>, InferCreationAttributes<CreditApplicationModel>> {
  declare id: string;
  declare organization_id: string;
  declare receivable_id: string;
  declare source_type: string;
  declare source_id: string;
  declare document_number: string | null;
  declare applied_cents: string | number;
  declare applied_at: string;
  declare created_at: Date;
  declare reversed_at: Date | null;
}

CreditApplicationModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    receivable_id: { type: DataTypes.CHAR(36), allowNull: false },
    source_type: { type: DataTypes.STRING(20), allowNull: false },
    source_id: { type: DataTypes.STRING(64), allowNull: false },
    document_number: { type: DataTypes.STRING(60), allowNull: true },
    applied_cents: { type: DataTypes.BIGINT, allowNull: false },
    applied_at: { type: DataTypes.DATEONLY, allowNull: false },
    created_at: { type: DataTypes.DATE, allowNull: false },
    reversed_at: { type: DataTypes.DATE, allowNull: true },
  },
  { sequelize, tableName: 'credit_applications', timestamps: false },
);

export class CustomerAdvanceModel extends Model<InferAttributes<CustomerAdvanceModel>, InferCreationAttributes<CustomerAdvanceModel>> {
  declare id: string;
  declare organization_id: string;
  declare customer_id: string;
  declare customer_name: string;
  declare customer_identification: string | null;
  declare origin: string;
  declare origin_id: string;
  declare related_invoice_id: string | null;
  declare document_number: string | null;
  declare currency_code: string;
  declare original_cents: string | number;
  declare version: number;
  declare created_at: Date;
  declare updated_at: Date;
  declare voided_at: Date | null;
}

CustomerAdvanceModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    customer_id: { type: DataTypes.CHAR(36), allowNull: false },
    customer_name: { type: DataTypes.STRING(300), allowNull: false },
    customer_identification: { type: DataTypes.STRING(20), allowNull: true },
    origin: { type: DataTypes.STRING(20), allowNull: false },
    origin_id: { type: DataTypes.STRING(64), allowNull: false },
    related_invoice_id: { type: DataTypes.CHAR(36), allowNull: true },
    document_number: { type: DataTypes.STRING(60), allowNull: true },
    currency_code: { type: DataTypes.CHAR(3), allowNull: false },
    original_cents: { type: DataTypes.BIGINT, allowNull: false },
    version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
    voided_at: { type: DataTypes.DATE, allowNull: true },
  },
  { sequelize, tableName: 'customer_advances', timestamps: false },
);

export class CustomerAdvanceApplicationModel extends Model<
  InferAttributes<CustomerAdvanceApplicationModel>,
  InferCreationAttributes<CustomerAdvanceApplicationModel>
> {
  declare id: string;
  declare organization_id: string;
  declare advance_id: string;
  declare receivable_id: string;
  declare applied_cents: string | number;
  declare created_at: Date;
}

CustomerAdvanceApplicationModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    advance_id: { type: DataTypes.CHAR(36), allowNull: false },
    receivable_id: { type: DataTypes.CHAR(36), allowNull: false },
    applied_cents: { type: DataTypes.BIGINT, allowNull: false },
    created_at: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'customer_advance_applications', timestamps: false },
);

export class CustomerTermsModel extends Model<InferAttributes<CustomerTermsModel>, InferCreationAttributes<CustomerTermsModel>> {
  declare organization_id: string;
  declare customer_id: string;
  declare customer_name: string;
  declare credit_days: number;
  declare credit_limit_cents: string | number | null;
  declare updated_by: string;
  declare updated_at: Date;
}

CustomerTermsModel.init(
  {
    organization_id: { type: DataTypes.CHAR(36), primaryKey: true },
    customer_id: { type: DataTypes.CHAR(36), primaryKey: true },
    customer_name: { type: DataTypes.STRING(300), allowNull: false },
    credit_days: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    credit_limit_cents: { type: DataTypes.BIGINT, allowNull: true },
    updated_by: { type: DataTypes.CHAR(36), allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'customer_terms', timestamps: false },
);

export class ReminderSettingsModel extends Model<InferAttributes<ReminderSettingsModel>, InferCreationAttributes<ReminderSettingsModel>> {
  declare organization_id: string;
  declare enabled: boolean;
  declare first_after_days: number;
  declare repeat_every_days: number;
  declare last_run_on: string | null;
  declare updated_by: string | null;
  declare created_at: Date;
  declare updated_at: Date;
}

ReminderSettingsModel.init(
  {
    organization_id: { type: DataTypes.CHAR(36), primaryKey: true },
    enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    first_after_days: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 3 },
    repeat_every_days: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 7 },
    last_run_on: { type: DataTypes.DATEONLY, allowNull: true },
    updated_by: { type: DataTypes.CHAR(36), allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'reminder_settings', timestamps: false },
);

export class ReceivableReminderModel extends Model<InferAttributes<ReceivableReminderModel>, InferCreationAttributes<ReceivableReminderModel>> {
  declare id: string;
  declare organization_id: string;
  declare receivable_id: string;
  declare customer_id: string;
  declare reminder_date: string;
  declare trigger_kind: string;
  declare sent_by: string | null;
  declare created_at: Date;
}

ReceivableReminderModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    receivable_id: { type: DataTypes.CHAR(36), allowNull: false },
    customer_id: { type: DataTypes.CHAR(36), allowNull: false },
    reminder_date: { type: DataTypes.DATEONLY, allowNull: false },
    trigger_kind: { type: DataTypes.STRING(10), allowNull: false },
    sent_by: { type: DataTypes.CHAR(36), allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'receivable_reminders', timestamps: false },
);

export class OpeningBalanceLoadModel extends Model<
  InferAttributes<OpeningBalanceLoadModel>,
  InferCreationAttributes<OpeningBalanceLoadModel>
> {
  declare id: string;
  declare organization_id: string;
  declare cutoff_date: string;
  declare loaded_by: string;
  declare reason: string;
  declare total_cents: string | number;
  declare created_at: Date;
}

OpeningBalanceLoadModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    cutoff_date: { type: DataTypes.DATEONLY, allowNull: false },
    loaded_by: { type: DataTypes.CHAR(36), allowNull: false },
    reason: { type: DataTypes.STRING(300), allowNull: false },
    total_cents: { type: DataTypes.BIGINT, allowNull: false },
    created_at: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'opening_balance_loads', timestamps: false },
);

export class OutboxModel extends Model<InferAttributes<OutboxModel>, InferCreationAttributes<OutboxModel>> {
  declare id: string;
  declare aggregate_type: string;
  declare aggregate_id: string;
  declare type: string;
  declare payload: unknown;
  declare occurred_at: Date;
  declare processed_at: Date | null;
}

OutboxModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    aggregate_type: { type: DataTypes.STRING(50), allowNull: false },
    aggregate_id: { type: DataTypes.CHAR(36), allowNull: false },
    type: { type: DataTypes.STRING(100), allowNull: false },
    payload: { type: DataTypes.JSON, allowNull: false },
    occurred_at: { type: DataTypes.DATE, allowNull: false },
    processed_at: { type: DataTypes.DATE, allowNull: true },
  },
  { sequelize, tableName: 'outbox_messages', timestamps: false },
);

// ── Cobros (bloque B) ────────────────────────────────────────────────────────

export class ReceiptModel extends Model<InferAttributes<ReceiptModel>, InferCreationAttributes<ReceiptModel>> {
  declare id: string;
  declare organization_id: string;
  declare number: string | null;
  declare customer_id: string;
  declare customer_name: string;
  declare customer_identification: string | null;
  declare receipt_date: string;
  declare method: string;
  declare account_role: string;
  declare reference: string | null;
  declare currency_code: string;
  declare total_cents: string | number;
  declare advance_used_cents: string | number;
  declare applied_cents: string | number;
  declare advance_cents: string | number;
  declare advance_uses: unknown;
  declare notes: string | null;
  declare status: string;
  declare void_reason: string | null;
  declare created_by: string;
  declare posted_by: string | null;
  declare voided_by: string | null;
  declare posted_at: Date | null;
  declare voided_at: Date | null;
  declare version: number;
  declare created_at: Date;
  declare updated_at: Date;
}

ReceiptModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    number: { type: DataTypes.STRING(20), allowNull: true },
    customer_id: { type: DataTypes.CHAR(36), allowNull: false },
    customer_name: { type: DataTypes.STRING(300), allowNull: false },
    customer_identification: { type: DataTypes.STRING(20), allowNull: true },
    receipt_date: { type: DataTypes.DATEONLY, allowNull: false },
    method: { type: DataTypes.STRING(20), allowNull: false },
    account_role: { type: DataTypes.STRING(10), allowNull: false },
    reference: { type: DataTypes.STRING(100), allowNull: true },
    currency_code: { type: DataTypes.CHAR(3), allowNull: false },
    total_cents: { type: DataTypes.BIGINT, allowNull: false },
    advance_used_cents: { type: DataTypes.BIGINT, allowNull: false },
    applied_cents: { type: DataTypes.BIGINT, allowNull: false },
    advance_cents: { type: DataTypes.BIGINT, allowNull: false },
    advance_uses: { type: DataTypes.JSON, allowNull: true },
    notes: { type: DataTypes.STRING(500), allowNull: true },
    status: { type: DataTypes.STRING(10), allowNull: false },
    void_reason: { type: DataTypes.STRING(300), allowNull: true },
    created_by: { type: DataTypes.CHAR(36), allowNull: false },
    posted_by: { type: DataTypes.CHAR(36), allowNull: true },
    voided_by: { type: DataTypes.CHAR(36), allowNull: true },
    posted_at: { type: DataTypes.DATE, allowNull: true },
    voided_at: { type: DataTypes.DATE, allowNull: true },
    version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'receipts', timestamps: false },
);

export class ReceiptLineModel extends Model<InferAttributes<ReceiptLineModel>, InferCreationAttributes<ReceiptLineModel>> {
  declare id: string;
  declare organization_id: string;
  declare receipt_id: string;
  declare receivable_id: string;
  declare applied_cents: string | number;
}

ReceiptLineModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    receipt_id: { type: DataTypes.CHAR(36), allowNull: false },
    receivable_id: { type: DataTypes.CHAR(36), allowNull: false },
    applied_cents: { type: DataTypes.BIGINT, allowNull: false },
  },
  { sequelize, tableName: 'receipt_lines', timestamps: false },
);

export class ReceiptAdvanceUseModel extends Model<InferAttributes<ReceiptAdvanceUseModel>, InferCreationAttributes<ReceiptAdvanceUseModel>> {
  declare id: string;
  declare organization_id: string;
  declare receipt_id: string;
  declare advance_id: string;
  declare used_cents: string | number;
  declare reversed_at: Date | null;
  declare created_at: Date;
}

ReceiptAdvanceUseModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    receipt_id: { type: DataTypes.CHAR(36), allowNull: false },
    advance_id: { type: DataTypes.CHAR(36), allowNull: false },
    used_cents: { type: DataTypes.BIGINT, allowNull: false },
    reversed_at: { type: DataTypes.DATE, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'receipt_advance_uses', timestamps: false },
);
