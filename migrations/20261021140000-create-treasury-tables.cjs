'use strict';

/**
 * Tesorería, Fase 3.1: submayor de cuentas por cobrar.
 *
 * Reglas de esquema que valen para todo el servicio:
 *  - importes en centavos BIGINT (nunca decimales);
 *  - todo lleva organization_id y toda consulta lo filtra: una organización no ve lo de otra;
 *  - el saldo de una partida NO es una columna: se deriva de `credit_applications` (y en el bloque B, de
 *    `receipt_applications`). Así, reintentar un evento no descuadra la cartera;
 *  - `UNIQUE (organization_id, source_type, source_id)` en `receivables`: es la idempotencia de la cartera;
 *  - outbox_messages / processed_events: patrón Outbox, esquema de @facturero/outbox-relay 0.2.x.
 *
 * Las tablas de cobros (`receipts`, `receipt_applications`, `receipt_sequences`) NO están aquí: son del bloque B y
 * llegan en su propia migración.
 */
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('receivables', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      customer_id: { type: Sequelize.CHAR(36), allowNull: false },
      // Copia del evento: la partida sigue siendo legible si el cliente cambia de nombre o se da de baja.
      customer_name: { type: Sequelize.STRING(300), allowNull: false },
      customer_identification: { type: Sequelize.STRING(20), allowNull: true },
      // invoice | credit_note | initial_balance
      source_type: { type: Sequelize.STRING(20), allowNull: false },
      // 64 y no 36: un saldo inicial usa `${loadId}:${indice}` como origen.
      source_id: { type: Sequelize.STRING(64), allowNull: false },
      document_number: { type: Sequelize.STRING(60), allowNull: true },
      // Fechas de calendario: nunca pasan por UTC.
      issue_date: { type: Sequelize.DATEONLY, allowNull: false },
      due_date: { type: Sequelize.DATEONLY, allowNull: false },
      currency_code: { type: Sequelize.CHAR(3), allowNull: false },
      original_cents: { type: Sequelize.BIGINT, allowNull: false },
      // open | partial | paid | written_off | cancelled
      status: { type: Sequelize.STRING(20), allowNull: false },
      version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('receivables', ['organization_id', 'source_type', 'source_id'], { unique: true, name: 'receivables_org_source_uq' });
    await queryInterface.addIndex('receivables', ['organization_id', 'customer_id'], { name: 'receivables_org_customer' });
    await queryInterface.addIndex('receivables', ['organization_id', 'status'], { name: 'receivables_org_status' });
    await queryInterface.addIndex('receivables', ['organization_id', 'due_date'], { name: 'receivables_org_due_date' });
    await queryInterface.sequelize.query(
      'ALTER TABLE receivables ADD CONSTRAINT receivables_amounts_chk CHECK (original_cents >= 0)',
    );
    await queryInterface.sequelize.query(
      "ALTER TABLE receivables ADD CONSTRAINT receivables_status_chk CHECK (status IN ('open','partial','paid','written_off','cancelled'))",
    );

    await queryInterface.createTable('credit_applications', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      receivable_id: { type: Sequelize.CHAR(36), allowNull: false },
      // credit_note | receipt
      source_type: { type: Sequelize.STRING(20), allowNull: false },
      source_id: { type: Sequelize.STRING(64), allowNull: false },
      document_number: { type: Sequelize.STRING(60), allowNull: true },
      applied_cents: { type: Sequelize.BIGINT, allowNull: false },
      applied_at: { type: Sequelize.DATEONLY, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
    });
    // Un comprobante no se aplica dos veces a la misma partida.
    await queryInterface.addIndex('credit_applications', ['organization_id', 'receivable_id', 'source_type', 'source_id'], { unique: true, name: 'credit_applications_uq' });
    await queryInterface.addIndex('credit_applications', ['organization_id', 'receivable_id'], { name: 'credit_applications_org_receivable' });
    await queryInterface.sequelize.query(
      'ALTER TABLE credit_applications ADD CONSTRAINT credit_applications_amount_chk CHECK (applied_cents > 0)',
    );

    await queryInterface.createTable('customer_advances', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      customer_id: { type: Sequelize.CHAR(36), allowNull: false },
      customer_name: { type: Sequelize.STRING(300), allowNull: false },
      customer_identification: { type: Sequelize.STRING(20), allowNull: true },
      // credit_note | receipt
      origin: { type: Sequelize.STRING(20), allowNull: false },
      origin_id: { type: Sequelize.STRING(64), allowNull: false },
      // Factura a la que se refiere el saldo a favor. `null`: se aplica a la próxima factura del cliente.
      related_invoice_id: { type: Sequelize.CHAR(36), allowNull: true },
      document_number: { type: Sequelize.STRING(60), allowNull: true },
      currency_code: { type: Sequelize.CHAR(3), allowNull: false },
      original_cents: { type: Sequelize.BIGINT, allowNull: false },
      version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('customer_advances', ['organization_id', 'origin', 'origin_id'], { unique: true, name: 'customer_advances_org_origin_uq' });
    await queryInterface.addIndex('customer_advances', ['organization_id', 'customer_id'], { name: 'customer_advances_org_customer' });
    await queryInterface.sequelize.query(
      'ALTER TABLE customer_advances ADD CONSTRAINT customer_advances_amount_chk CHECK (original_cents >= 0)',
    );

    await queryInterface.createTable('customer_advance_applications', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      advance_id: { type: Sequelize.CHAR(36), allowNull: false },
      receivable_id: { type: Sequelize.CHAR(36), allowNull: false },
      applied_cents: { type: Sequelize.BIGINT, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
    });
    // Un saldo a favor no se aplica dos veces a la misma partida.
    await queryInterface.addIndex('customer_advance_applications', ['organization_id', 'advance_id', 'receivable_id'], { unique: true, name: 'customer_advance_applications_uq' });
    await queryInterface.sequelize.query(
      'ALTER TABLE customer_advance_applications ADD CONSTRAINT customer_advance_applications_amount_chk CHECK (applied_cents > 0)',
    );

    await queryInterface.createTable('customer_terms', {
      organization_id: { type: Sequelize.CHAR(36), primaryKey: true },
      customer_id: { type: Sequelize.CHAR(36), primaryKey: true },
      customer_name: { type: Sequelize.STRING(300), allowNull: false },
      credit_days: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      // `null`: sin cupo. El cupo se guarda y se muestra; bloquear la facturación es decisión del dueño.
      credit_limit_cents: { type: Sequelize.BIGINT, allowNull: true },
      updated_by: { type: Sequelize.CHAR(36), allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.sequelize.query(
      'ALTER TABLE customer_terms ADD CONSTRAINT customer_terms_credit_days_chk CHECK (credit_days >= 0 AND credit_days <= 365)',
    );
    await queryInterface.sequelize.query(
      'ALTER TABLE customer_terms ADD CONSTRAINT customer_terms_limit_chk CHECK (credit_limit_cents IS NULL OR credit_limit_cents >= 0)',
    );

    await queryInterface.createTable('opening_balance_loads', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      // Una carga por (organización, fecha de corte): repetirla duplicaría la cartera.
      cutoff_date: { type: Sequelize.DATEONLY, allowNull: false },
      loaded_by: { type: Sequelize.CHAR(36), allowNull: false },
      reason: { type: Sequelize.STRING(300), allowNull: false },
      total_cents: { type: Sequelize.BIGINT, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('opening_balance_loads', ['organization_id', 'cutoff_date'], { unique: true, name: 'opening_balance_loads_org_cutoff_uq' });
    await queryInterface.sequelize.query(
      'ALTER TABLE opening_balance_loads ADD CONSTRAINT opening_balance_loads_total_chk CHECK (total_cents >= 0)',
    );

    await queryInterface.createTable('outbox_messages', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      aggregate_type: { type: Sequelize.STRING(50), allowNull: false },
      aggregate_id: { type: Sequelize.CHAR(36), allowNull: false },
      type: { type: Sequelize.STRING(100), allowNull: false },
      payload: { type: Sequelize.JSON, allowNull: false },
      occurred_at: { type: Sequelize.DATE, allowNull: false },
      processed_at: { type: Sequelize.DATE, allowNull: true },
    });
    await queryInterface.addIndex('outbox_messages', ['processed_at']);

    await queryInterface.createTable('processed_events', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      event_type: { type: Sequelize.STRING(100), allowNull: false },
      routing_key: { type: Sequelize.STRING(200), allowNull: false },
      payload: { type: Sequelize.JSON, allowNull: false },
      status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'processed' },
      last_error: { type: Sequelize.TEXT, allowNull: true },
      processed_at: { type: Sequelize.DATE, allowNull: false },
    });
  },

  async down(queryInterface) {
    for (const table of [
      'processed_events', 'outbox_messages', 'opening_balance_loads', 'customer_terms',
      'customer_advance_applications', 'customer_advances', 'credit_applications', 'receivables',
    ]) {
      await queryInterface.dropTable(table);
    }
  },
};
