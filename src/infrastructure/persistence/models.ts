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

// ── Cuentas por pagar y pagos (bloque D) ─────────────────────────────────────

export class PayableModel extends Model<InferAttributes<PayableModel>, InferCreationAttributes<PayableModel>> {
  declare id: string;
  declare organization_id: string;
  declare supplier_id: string;
  declare supplier_name: string;
  declare supplier_identification: string | null;
  declare source_type: string;
  declare source_id: string;
  declare document_number: string | null;
  declare internal_number: string | null;
  declare issue_date: string;
  declare due_date: string;
  declare currency_code: string;
  declare original_cents: string | number;
  declare status: string;
  declare version: number;
  declare created_at: Date;
  declare updated_at: Date;
}

PayableModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    supplier_id: { type: DataTypes.CHAR(36), allowNull: false },
    supplier_name: { type: DataTypes.STRING(300), allowNull: false },
    supplier_identification: { type: DataTypes.STRING(20), allowNull: true },
    source_type: { type: DataTypes.STRING(20), allowNull: false },
    source_id: { type: DataTypes.STRING(64), allowNull: false },
    document_number: { type: DataTypes.STRING(60), allowNull: true },
    internal_number: { type: DataTypes.STRING(30), allowNull: true },
    issue_date: { type: DataTypes.DATEONLY, allowNull: false },
    due_date: { type: DataTypes.DATEONLY, allowNull: false },
    currency_code: { type: DataTypes.CHAR(3), allowNull: false },
    original_cents: { type: DataTypes.BIGINT, allowNull: false },
    status: { type: DataTypes.STRING(20), allowNull: false },
    version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'payables', timestamps: false },
);

export class PayableApplicationModel extends Model<InferAttributes<PayableApplicationModel>, InferCreationAttributes<PayableApplicationModel>> {
  declare id: string;
  declare organization_id: string;
  declare payable_id: string;
  declare source_type: string;
  declare source_id: string;
  declare document_number: string | null;
  declare applied_cents: string | number;
  declare applied_at: string;
  declare reversed_at: Date | null;
  declare created_at: Date;
}

PayableApplicationModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    payable_id: { type: DataTypes.CHAR(36), allowNull: false },
    source_type: { type: DataTypes.STRING(20), allowNull: false },
    source_id: { type: DataTypes.STRING(64), allowNull: false },
    document_number: { type: DataTypes.STRING(60), allowNull: true },
    applied_cents: { type: DataTypes.BIGINT, allowNull: false },
    applied_at: { type: DataTypes.DATEONLY, allowNull: false },
    reversed_at: { type: DataTypes.DATE, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'payable_applications', timestamps: false },
);

export class SupplierAdvanceModel extends Model<InferAttributes<SupplierAdvanceModel>, InferCreationAttributes<SupplierAdvanceModel>> {
  declare id: string;
  declare organization_id: string;
  declare supplier_id: string;
  declare supplier_name: string;
  declare supplier_identification: string | null;
  declare origin_id: string;
  declare document_number: string | null;
  declare currency_code: string;
  declare original_cents: string | number;
  declare voided_at: Date | null;
  declare version: number;
  declare created_at: Date;
  declare updated_at: Date;
}

SupplierAdvanceModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    supplier_id: { type: DataTypes.CHAR(36), allowNull: false },
    supplier_name: { type: DataTypes.STRING(300), allowNull: false },
    supplier_identification: { type: DataTypes.STRING(20), allowNull: true },
    origin_id: { type: DataTypes.CHAR(36), allowNull: false },
    document_number: { type: DataTypes.STRING(60), allowNull: true },
    currency_code: { type: DataTypes.CHAR(3), allowNull: false },
    original_cents: { type: DataTypes.BIGINT, allowNull: false },
    voided_at: { type: DataTypes.DATE, allowNull: true },
    version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'supplier_advances', timestamps: false },
);

export class PaymentModel extends Model<InferAttributes<PaymentModel>, InferCreationAttributes<PaymentModel>> {
  declare id: string;
  declare organization_id: string;
  declare number: string | null;
  declare supplier_id: string;
  declare supplier_name: string;
  declare supplier_identification: string | null;
  declare payment_date: string;
  declare method: string;
  declare account_role: string;
  declare bank_account_id: string | null;
  declare reference: string | null;
  declare currency_code: string;
  declare total_cents: string | number;
  declare advance_used_cents: string | number;
  declare applied_cents: string | number;
  declare advance_cents: string | number;
  declare lines: unknown;
  declare advance_uses: unknown;
  declare notes: string | null;
  declare status: string;
  declare void_reason: string | null;
  declare created_by: string;
  declare approved_by: string | null;
  declare posted_by: string | null;
  declare voided_by: string | null;
  declare approved_at: Date | null;
  declare posted_at: Date | null;
  declare voided_at: Date | null;
  declare version: number;
  declare created_at: Date;
  declare updated_at: Date;
}

PaymentModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    number: { type: DataTypes.STRING(20), allowNull: true },
    supplier_id: { type: DataTypes.CHAR(36), allowNull: false },
    supplier_name: { type: DataTypes.STRING(300), allowNull: false },
    supplier_identification: { type: DataTypes.STRING(20), allowNull: true },
    payment_date: { type: DataTypes.DATEONLY, allowNull: false },
    method: { type: DataTypes.STRING(20), allowNull: false },
    account_role: { type: DataTypes.STRING(10), allowNull: false },
    bank_account_id: { type: DataTypes.CHAR(36), allowNull: true },
    reference: { type: DataTypes.STRING(100), allowNull: true },
    currency_code: { type: DataTypes.CHAR(3), allowNull: false },
    total_cents: { type: DataTypes.BIGINT, allowNull: false },
    advance_used_cents: { type: DataTypes.BIGINT, allowNull: false },
    applied_cents: { type: DataTypes.BIGINT, allowNull: false },
    advance_cents: { type: DataTypes.BIGINT, allowNull: false },
    lines: { type: DataTypes.JSON, allowNull: false },
    advance_uses: { type: DataTypes.JSON, allowNull: true },
    notes: { type: DataTypes.STRING(500), allowNull: true },
    status: { type: DataTypes.STRING(10), allowNull: false },
    void_reason: { type: DataTypes.STRING(300), allowNull: true },
    created_by: { type: DataTypes.CHAR(36), allowNull: false },
    approved_by: { type: DataTypes.CHAR(36), allowNull: true },
    posted_by: { type: DataTypes.CHAR(36), allowNull: true },
    voided_by: { type: DataTypes.CHAR(36), allowNull: true },
    approved_at: { type: DataTypes.DATE, allowNull: true },
    posted_at: { type: DataTypes.DATE, allowNull: true },
    voided_at: { type: DataTypes.DATE, allowNull: true },
    version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'payments', timestamps: false },
);

export class PaymentAdvanceUseModel extends Model<InferAttributes<PaymentAdvanceUseModel>, InferCreationAttributes<PaymentAdvanceUseModel>> {
  declare id: string;
  declare organization_id: string;
  declare payment_id: string;
  declare advance_id: string;
  declare used_cents: string | number;
  declare reversed_at: Date | null;
  declare created_at: Date;
}

PaymentAdvanceUseModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    payment_id: { type: DataTypes.CHAR(36), allowNull: false },
    advance_id: { type: DataTypes.CHAR(36), allowNull: false },
    used_cents: { type: DataTypes.BIGINT, allowNull: false },
    reversed_at: { type: DataTypes.DATE, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'payment_advance_uses', timestamps: false },
);

export class PaymentSettingsModel extends Model<InferAttributes<PaymentSettingsModel>, InferCreationAttributes<PaymentSettingsModel>> {
  declare organization_id: string;
  declare approval_threshold_cents: string | number | null;
  declare updated_by: string | null;
  declare created_at: Date;
  declare updated_at: Date;
}

PaymentSettingsModel.init(
  {
    organization_id: { type: DataTypes.CHAR(36), primaryKey: true },
    approval_threshold_cents: { type: DataTypes.BIGINT, allowNull: true },
    updated_by: { type: DataTypes.CHAR(36), allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'payment_settings', timestamps: false },
);

export class UnmatchedWithholdingModel extends Model<InferAttributes<UnmatchedWithholdingModel>, InferCreationAttributes<UnmatchedWithholdingModel>> {
  declare id: string;
  declare organization_id: string;
  declare withholding_id: string;
  declare number: string | null;
  declare supplier_identification: string;
  declare support_number: string;
  declare issue_date: string | null;
  declare total_withheld_cents: string | number;
  declare created_at: Date;
}

UnmatchedWithholdingModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    withholding_id: { type: DataTypes.STRING(64), allowNull: false },
    number: { type: DataTypes.STRING(60), allowNull: true },
    supplier_identification: { type: DataTypes.STRING(20), allowNull: false },
    support_number: { type: DataTypes.STRING(30), allowNull: false },
    issue_date: { type: DataTypes.DATEONLY, allowNull: true },
    total_withheld_cents: { type: DataTypes.BIGINT, allowNull: false },
    created_at: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'unmatched_withholdings', timestamps: false },
);

export class PayableOpeningLoadModel extends Model<InferAttributes<PayableOpeningLoadModel>, InferCreationAttributes<PayableOpeningLoadModel>> {
  declare id: string;
  declare organization_id: string;
  declare cutoff_date: string;
  declare loaded_by: string;
  declare reason: string;
  declare total_cents: string | number;
  declare created_at: Date;
}

PayableOpeningLoadModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    cutoff_date: { type: DataTypes.DATEONLY, allowNull: false },
    loaded_by: { type: DataTypes.CHAR(36), allowNull: false },
    reason: { type: DataTypes.STRING(300), allowNull: false },
    total_cents: { type: DataTypes.BIGINT, allowNull: false },
    created_at: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'payable_opening_loads', timestamps: false },
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
  declare bank_account_id: string | null;
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
    bank_account_id: { type: DataTypes.CHAR(36), allowNull: true },
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

// ── Bancos, extractos y conciliación (bloque E) ──────────────────────────────

export class BankAccountModel extends Model<InferAttributes<BankAccountModel>, InferCreationAttributes<BankAccountModel>> {
  declare id: string;
  declare organization_id: string;
  declare name: string;
  declare bank_name: string;
  declare account_type: string;
  declare account_last4: string | null;
  declare currency_code: string;
  declare opening_balance_cents: string | number;
  declare opening_date: string;
  declare is_active: boolean;
  declare import_profile: unknown;
  declare version: number;
  declare created_at: Date;
  declare updated_at: Date;
}

BankAccountModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    name: { type: DataTypes.STRING(80), allowNull: false },
    bank_name: { type: DataTypes.STRING(120), allowNull: false },
    account_type: { type: DataTypes.STRING(10), allowNull: false },
    account_last4: { type: DataTypes.STRING(4), allowNull: true },
    currency_code: { type: DataTypes.CHAR(3), allowNull: false },
    opening_balance_cents: { type: DataTypes.BIGINT, allowNull: false },
    opening_date: { type: DataTypes.DATEONLY, allowNull: false },
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    import_profile: { type: DataTypes.JSON, allowNull: true },
    version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'bank_accounts', timestamps: false },
);

export class BankMovementModel extends Model<InferAttributes<BankMovementModel>, InferCreationAttributes<BankMovementModel>> {
  declare id: string;
  declare organization_id: string;
  declare bank_account_id: string | null;
  declare source_type: string;
  declare source_id: string;
  declare movement_date: string;
  declare amount_cents: string | number;
  declare reference: string | null;
  declare description: string;
  declare kind: string | null;
  declare status: string;
  declare created_by: string | null;
  declare version: number;
  declare created_at: Date;
  declare updated_at: Date;
}

BankMovementModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    bank_account_id: { type: DataTypes.CHAR(36), allowNull: true },
    source_type: { type: DataTypes.STRING(12), allowNull: false },
    source_id: { type: DataTypes.CHAR(36), allowNull: false },
    movement_date: { type: DataTypes.DATEONLY, allowNull: false },
    amount_cents: { type: DataTypes.BIGINT, allowNull: false },
    reference: { type: DataTypes.STRING(100), allowNull: true },
    description: { type: DataTypes.STRING(300), allowNull: false },
    kind: { type: DataTypes.STRING(12), allowNull: true },
    status: { type: DataTypes.STRING(10), allowNull: false },
    created_by: { type: DataTypes.CHAR(36), allowNull: true },
    version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'bank_movements', timestamps: false },
);

export class BankStatementModel extends Model<InferAttributes<BankStatementModel>, InferCreationAttributes<BankStatementModel>> {
  declare id: string;
  declare organization_id: string;
  declare bank_account_id: string;
  declare file_name: string | null;
  declare content_hash: string;
  declare period_start: string;
  declare period_end: string;
  declare line_count: number;
  declare closing_balance_cents: string | number | null;
  declare closing_date: string | null;
  declare imported_by: string;
  declare imported_at: Date;
}

BankStatementModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    bank_account_id: { type: DataTypes.CHAR(36), allowNull: false },
    file_name: { type: DataTypes.STRING(200), allowNull: true },
    content_hash: { type: DataTypes.CHAR(64), allowNull: false },
    period_start: { type: DataTypes.DATEONLY, allowNull: false },
    period_end: { type: DataTypes.DATEONLY, allowNull: false },
    line_count: { type: DataTypes.INTEGER, allowNull: false },
    closing_balance_cents: { type: DataTypes.BIGINT, allowNull: true },
    closing_date: { type: DataTypes.DATEONLY, allowNull: true },
    imported_by: { type: DataTypes.CHAR(36), allowNull: false },
    imported_at: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'bank_statements', timestamps: false },
);

export class BankStatementLineModel extends Model<InferAttributes<BankStatementLineModel>, InferCreationAttributes<BankStatementLineModel>> {
  declare id: string;
  declare organization_id: string;
  declare bank_account_id: string;
  declare statement_id: string;
  declare line_date: string;
  declare description: string;
  declare reference: string | null;
  declare amount_cents: string | number;
  declare balance_cents: string | number | null;
  declare fingerprint: string;
  declare status: string;
  declare external_reason: string | null;
  declare reconciliation_id: string | null;
  declare created_at: Date;
  declare updated_at: Date;
}

BankStatementLineModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    bank_account_id: { type: DataTypes.CHAR(36), allowNull: false },
    statement_id: { type: DataTypes.CHAR(36), allowNull: false },
    line_date: { type: DataTypes.DATEONLY, allowNull: false },
    description: { type: DataTypes.STRING(300), allowNull: false },
    reference: { type: DataTypes.STRING(80), allowNull: true },
    amount_cents: { type: DataTypes.BIGINT, allowNull: false },
    balance_cents: { type: DataTypes.BIGINT, allowNull: true },
    fingerprint: { type: DataTypes.STRING(80), allowNull: false },
    status: { type: DataTypes.STRING(10), allowNull: false },
    external_reason: { type: DataTypes.STRING(300), allowNull: true },
    reconciliation_id: { type: DataTypes.CHAR(36), allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'bank_statement_lines', timestamps: false },
);

export class BankMatchModel extends Model<InferAttributes<BankMatchModel>, InferCreationAttributes<BankMatchModel>> {
  declare id: string;
  declare organization_id: string;
  declare bank_account_id: string;
  declare line_id: string;
  declare movement_id: string;
  declare amount_cents: string | number;
  declare method: string;
  declare matched_by: string;
  declare matched_at: Date;
  declare reconciliation_id: string | null;
}

BankMatchModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    bank_account_id: { type: DataTypes.CHAR(36), allowNull: false },
    line_id: { type: DataTypes.CHAR(36), allowNull: false },
    movement_id: { type: DataTypes.CHAR(36), allowNull: false },
    amount_cents: { type: DataTypes.BIGINT, allowNull: false },
    method: { type: DataTypes.STRING(10), allowNull: false },
    matched_by: { type: DataTypes.CHAR(36), allowNull: false },
    matched_at: { type: DataTypes.DATE, allowNull: false },
    reconciliation_id: { type: DataTypes.CHAR(36), allowNull: true },
  },
  { sequelize, tableName: 'bank_matches', timestamps: false },
);

export class BankReconciliationModel extends Model<InferAttributes<BankReconciliationModel>, InferCreationAttributes<BankReconciliationModel>> {
  declare id: string;
  declare organization_id: string;
  declare bank_account_id: string;
  declare cutoff_date: string;
  declare statement_balance_cents: string | number;
  declare register_balance_cents: string | number;
  declare pending_cents: string | number;
  declare difference_cents: string | number;
  declare status: string;
  declare closed_by: string | null;
  declare closed_at: Date | null;
  declare reopened_by: string | null;
  declare reopened_at: Date | null;
  declare notes: string | null;
  declare version: number;
  declare created_at: Date;
}

BankReconciliationModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    bank_account_id: { type: DataTypes.CHAR(36), allowNull: false },
    cutoff_date: { type: DataTypes.DATEONLY, allowNull: false },
    statement_balance_cents: { type: DataTypes.BIGINT, allowNull: false },
    register_balance_cents: { type: DataTypes.BIGINT, allowNull: false },
    pending_cents: { type: DataTypes.BIGINT, allowNull: false },
    difference_cents: { type: DataTypes.BIGINT, allowNull: false },
    status: { type: DataTypes.STRING(10), allowNull: false },
    closed_by: { type: DataTypes.CHAR(36), allowNull: true },
    closed_at: { type: DataTypes.DATE, allowNull: true },
    reopened_by: { type: DataTypes.CHAR(36), allowNull: true },
    reopened_at: { type: DataTypes.DATE, allowNull: true },
    notes: { type: DataTypes.STRING(500), allowNull: true },
    version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    created_at: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'bank_reconciliations', timestamps: false },
);
