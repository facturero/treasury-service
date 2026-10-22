'use strict';

/**
 * Tesorería, bloque D: cuentas por pagar y pagos a proveedores. Espejo de las tablas de cartera y cobros.
 *
 * Decisiones de esquema:
 *  - El saldo de una deuda NO es una columna: se deriva de `payable_applications` vigentes (pagos y retenciones). Un pago o una retención
 *    anulados NO se borran: se marcan con `reversed_at` y la suma los ignora.
 *  - `UNIQUE (organization_id, source_type, source_id)` en `payables` es la idempotencia: el mismo `purchasing.bill.posted` reintentado no
 *    abre dos deudas. `UNIQUE (organization_id, payable_id, source_type, source_id)` en las aplicaciones: un pago (o una retención) no se aplica
 *    dos veces a la misma deuda.
 *  - El vencimiento viene de la factura de compra (`due_date`): no hay días de crédito que calcular.
 *  - El número `PG-AAAA-NNNNNN` se asigna al CONTABILIZAR (los borradores no gastan secuencial).
 *  - `CHECK (total_cents + advance_used_cents = applied_cents + advance_cents)`: un pago incoherente no entra ni por error.
 *  - Las líneas y los anticipos del BORRADOR viajan en columnas JSON de `payments`; al contabilizar pasan a las tablas que el saldo suma
 *    (`payable_applications`, `payment_advance_uses`). Así el borrador no necesita tablas hijas con su propio ciclo.
 *  - `payment_settings.approval_threshold_cents` NULL = sin aprobación (nace apagado: el umbral lo decide el dueño).
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('payables', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      supplier_id: { type: Sequelize.CHAR(36), allowNull: false },
      supplier_name: { type: Sequelize.STRING(300), allowNull: false },
      supplier_identification: { type: Sequelize.STRING(20), allowNull: true },
      // purchase_bill | initial_balance
      source_type: { type: Sequelize.STRING(20), allowNull: false },
      source_id: { type: Sequelize.STRING(64), allowNull: false },
      // Número de la factura del PROVEEDOR (se normaliza para emparejar la retención).
      document_number: { type: Sequelize.STRING(60), allowNull: true },
      // FC-AAAA-NNNNNN
      internal_number: { type: Sequelize.STRING(30), allowNull: true },
      issue_date: { type: Sequelize.DATEONLY, allowNull: false },
      due_date: { type: Sequelize.DATEONLY, allowNull: false },
      currency_code: { type: Sequelize.CHAR(3), allowNull: false },
      original_cents: { type: Sequelize.BIGINT, allowNull: false },
      // open | partial | paid | cancelled
      status: { type: Sequelize.STRING(20), allowNull: false },
      version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('payables', ['organization_id', 'source_type', 'source_id'], { unique: true, name: 'payables_org_source_uq' });
    await queryInterface.addIndex('payables', ['organization_id', 'supplier_id'], { name: 'payables_org_supplier' });
    await queryInterface.addIndex('payables', ['organization_id', 'status', 'due_date'], { name: 'payables_org_status_due' });
    await queryInterface.addIndex('payables', ['organization_id', 'supplier_identification'], { name: 'payables_org_ruc' });

    await queryInterface.createTable('payable_applications', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      payable_id: { type: Sequelize.CHAR(36), allowNull: false },
      // payment | withholding
      source_type: { type: Sequelize.STRING(20), allowNull: false },
      source_id: { type: Sequelize.STRING(64), allowNull: false },
      document_number: { type: Sequelize.STRING(60), allowNull: true },
      applied_cents: { type: Sequelize.BIGINT, allowNull: false },
      applied_at: { type: Sequelize.DATEONLY, allowNull: false },
      reversed_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('payable_applications', ['organization_id', 'payable_id', 'source_type', 'source_id'], { unique: true, name: 'payable_applications_uq' });
    await queryInterface.addIndex('payable_applications', ['organization_id', 'source_type', 'source_id'], { name: 'payable_applications_source' });
    await queryInterface.sequelize.query('ALTER TABLE payable_applications ADD CONSTRAINT payable_applications_positive_ck CHECK (applied_cents > 0)');

    await queryInterface.createTable('supplier_advances', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      supplier_id: { type: Sequelize.CHAR(36), allowNull: false },
      supplier_name: { type: Sequelize.STRING(300), allowNull: false },
      supplier_identification: { type: Sequelize.STRING(20), allowNull: true },
      // Id del pago que lo originó.
      origin_id: { type: Sequelize.CHAR(36), allowNull: false },
      document_number: { type: Sequelize.STRING(60), allowNull: true },
      currency_code: { type: Sequelize.CHAR(3), allowNull: false },
      original_cents: { type: Sequelize.BIGINT, allowNull: false },
      voided_at: { type: Sequelize.DATE, allowNull: true },
      version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('supplier_advances', ['organization_id', 'origin_id'], { unique: true, name: 'supplier_advances_origin_uq' });
    await queryInterface.addIndex('supplier_advances', ['organization_id', 'supplier_id'], { name: 'supplier_advances_org_supplier' });

    await queryInterface.createTable('payments', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      // NULL mientras es borrador: se asigna al contabilizar.
      number: { type: Sequelize.STRING(20), allowNull: true },
      supplier_id: { type: Sequelize.CHAR(36), allowNull: false },
      supplier_name: { type: Sequelize.STRING(300), allowNull: false },
      supplier_identification: { type: Sequelize.STRING(20), allowNull: true },
      payment_date: { type: Sequelize.DATEONLY, allowNull: false },
      // cash | transfer | check | other
      method: { type: Sequelize.STRING(20), allowNull: false },
      // cash | bank
      account_role: { type: Sequelize.STRING(10), allowNull: false },
      reference: { type: Sequelize.STRING(100), allowNull: true },
      currency_code: { type: Sequelize.CHAR(3), allowNull: false },
      // Lo que salió de verdad de caja o banco.
      total_cents: { type: Sequelize.BIGINT, allowNull: false },
      advance_used_cents: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      applied_cents: { type: Sequelize.BIGINT, allowNull: false },
      // Excedente: queda como anticipo a proveedores.
      advance_cents: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      // [{ payableId, appliedCents }] y [{ advanceId, usedCents }]: lo que el pago piensa hacer. Al contabilizar pasan a las tablas que suma el saldo.
      lines: { type: Sequelize.JSON, allowNull: false },
      advance_uses: { type: Sequelize.JSON, allowNull: true },
      notes: { type: Sequelize.STRING(500), allowNull: true },
      // draft | approved | posted | voided
      status: { type: Sequelize.STRING(10), allowNull: false },
      void_reason: { type: Sequelize.STRING(300), allowNull: true },
      created_by: { type: Sequelize.CHAR(36), allowNull: false },
      approved_by: { type: Sequelize.CHAR(36), allowNull: true },
      posted_by: { type: Sequelize.CHAR(36), allowNull: true },
      voided_by: { type: Sequelize.CHAR(36), allowNull: true },
      approved_at: { type: Sequelize.DATE, allowNull: true },
      posted_at: { type: Sequelize.DATE, allowNull: true },
      voided_at: { type: Sequelize.DATE, allowNull: true },
      version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('payments', ['organization_id', 'number'], { unique: true, name: 'payments_org_number_uq' });
    await queryInterface.addIndex('payments', ['organization_id', 'supplier_id'], { name: 'payments_org_supplier' });
    await queryInterface.addIndex('payments', ['organization_id', 'status'], { name: 'payments_org_status' });
    await queryInterface.addIndex('payments', ['organization_id', 'payment_date'], { name: 'payments_org_date' });
    await queryInterface.sequelize.query(
      'ALTER TABLE payments ADD CONSTRAINT payments_amounts_ck CHECK (total_cents >= 0 AND advance_used_cents >= 0 AND applied_cents >= 0 AND advance_cents >= 0 AND total_cents + advance_used_cents = applied_cents + advance_cents)',
    );

    await queryInterface.createTable('payment_advance_uses', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      payment_id: { type: Sequelize.CHAR(36), allowNull: false },
      advance_id: { type: Sequelize.CHAR(36), allowNull: false },
      used_cents: { type: Sequelize.BIGINT, allowNull: false },
      reversed_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('payment_advance_uses', ['payment_id', 'advance_id'], { unique: true, name: 'payment_advance_uses_uq' });
    await queryInterface.addIndex('payment_advance_uses', ['organization_id', 'advance_id'], { name: 'payment_advance_uses_advance' });

    await queryInterface.createTable('payment_sequences', {
      organization_id: { type: Sequelize.CHAR(36), allowNull: false, primaryKey: true },
      year: { type: Sequelize.INTEGER, allowNull: false, primaryKey: true },
      current_value: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
    });

    await queryInterface.createTable('payment_settings', {
      organization_id: { type: Sequelize.CHAR(36), primaryKey: true },
      approval_threshold_cents: { type: Sequelize.BIGINT, allowNull: true },
      updated_by: { type: Sequelize.CHAR(36), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.createTable('unmatched_withholdings', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      withholding_id: { type: Sequelize.STRING(64), allowNull: false },
      number: { type: Sequelize.STRING(60), allowNull: true },
      supplier_identification: { type: Sequelize.STRING(20), allowNull: false },
      support_number: { type: Sequelize.STRING(30), allowNull: false },
      issue_date: { type: Sequelize.DATEONLY, allowNull: true },
      total_withheld_cents: { type: Sequelize.BIGINT, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('unmatched_withholdings', ['organization_id', 'withholding_id'], { unique: true, name: 'unmatched_withholdings_uq' });
    await queryInterface.addIndex('unmatched_withholdings', ['organization_id', 'supplier_identification', 'support_number'], { name: 'unmatched_withholdings_doc' });

    await queryInterface.createTable('payable_opening_loads', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      cutoff_date: { type: Sequelize.DATEONLY, allowNull: false },
      loaded_by: { type: Sequelize.CHAR(36), allowNull: false },
      reason: { type: Sequelize.STRING(300), allowNull: false },
      total_cents: { type: Sequelize.BIGINT, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('payable_opening_loads', ['organization_id', 'cutoff_date'], { unique: true, name: 'payable_opening_loads_uq' });
  },

  async down(queryInterface) {
    for (const table of ['payable_opening_loads', 'unmatched_withholdings', 'payment_settings', 'payment_sequences', 'payment_advance_uses', 'payments', 'supplier_advances', 'payable_applications', 'payables']) {
      await queryInterface.dropTable(table);
    }
  },
};
