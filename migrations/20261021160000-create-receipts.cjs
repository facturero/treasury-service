'use strict';

/**
 * Tesorería, bloque B: cobros (recibos), anticipos de cliente y su aplicación.
 *
 * Decisiones de esquema:
 *  - Un recibo se aplica a las partidas con los MISMOS `credit_applications` que las notas de crédito (`source_type = 'receipt'`,
 *    `source_id` = id del recibo): el saldo de una partida sigue derivándose de UNA suma, no de dos. Al anular el recibo esas filas
 *    NO se borran: se marcan con `reversed_at` y la suma las ignora (nada se borra; la historia queda).
 *  - El excedente de un cobro es un `customer_advances` con origen `receipt`. Si se anula el recibo, el anticipo se marca
 *    `voided_at`. El anticipo ya consumido por otro recibo impide la anulación (lo comprueba el caso de uso).
 *  - Lo que un recibo consume de anticipos anteriores va en `receipt_advance_uses`, no en `customer_advance_applications` (esa
 *    tabla liga un anticipo con una PARTIDA; aquí el anticipo se consume contra el recibo completo, que es lo que asienta
 *    contabilidad: Dr anticipos de clientes).
 *  - El número `RC-AAAA-NNNNNN` se asigna al CONTABILIZAR (los borradores no gastan secuencial): contador por (organización, año).
 *  - `CHECK (total_cents + advance_used_cents = applied_cents + advance_cents)`: un recibo incoherente no entra ni por error.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('receipts', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      // NULL mientras es borrador: se asigna al contabilizar.
      number: { type: Sequelize.STRING(20), allowNull: true },
      customer_id: { type: Sequelize.CHAR(36), allowNull: false },
      customer_name: { type: Sequelize.STRING(300), allowNull: false },
      customer_identification: { type: Sequelize.STRING(20), allowNull: true },
      receipt_date: { type: Sequelize.DATEONLY, allowNull: false },
      // cash | transfer | check | card | other
      method: { type: Sequelize.STRING(20), allowNull: false },
      // cash | bank: el rol contable que recibe el dinero (una cuenta por rol y organización en contabilidad).
      account_role: { type: Sequelize.STRING(10), allowNull: false },
      reference: { type: Sequelize.STRING(100), allowNull: true },
      currency_code: { type: Sequelize.CHAR(3), allowNull: false },
      // Lo que entró de verdad (caja o banco).
      total_cents: { type: Sequelize.BIGINT, allowNull: false },
      // De anticipos anteriores del cliente que este recibo consume (no entra dinero).
      advance_used_cents: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      applied_cents: { type: Sequelize.BIGINT, allowNull: false },
      // Excedente: queda como anticipo nuevo del cliente.
      advance_cents: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      // Borrador: qué anticipos piensa consumir ([{ advanceId, usedCents }]). Al contabilizar pasan a `receipt_advance_uses`.
      advance_uses: { type: Sequelize.JSON, allowNull: true },
      notes: { type: Sequelize.STRING(500), allowNull: true },
      // draft | posted | voided
      status: { type: Sequelize.STRING(10), allowNull: false },
      void_reason: { type: Sequelize.STRING(300), allowNull: true },
      created_by: { type: Sequelize.CHAR(36), allowNull: false },
      posted_by: { type: Sequelize.CHAR(36), allowNull: true },
      voided_by: { type: Sequelize.CHAR(36), allowNull: true },
      posted_at: { type: Sequelize.DATE, allowNull: true },
      voided_at: { type: Sequelize.DATE, allowNull: true },
      version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('receipts', ['organization_id', 'number'], { unique: true, name: 'receipts_org_number_uq' });
    await queryInterface.addIndex('receipts', ['organization_id', 'customer_id'], { name: 'receipts_org_customer' });
    await queryInterface.addIndex('receipts', ['organization_id', 'status'], { name: 'receipts_org_status' });
    await queryInterface.addIndex('receipts', ['organization_id', 'receipt_date'], { name: 'receipts_org_date' });
    await queryInterface.sequelize.query(
      'ALTER TABLE receipts ADD CONSTRAINT receipts_amounts_chk CHECK (total_cents >= 0 AND advance_used_cents >= 0 AND applied_cents >= 0 AND advance_cents >= 0 AND total_cents + advance_used_cents = applied_cents + advance_cents AND total_cents + advance_used_cents > 0)',
    );
    await queryInterface.sequelize.query("ALTER TABLE receipts ADD CONSTRAINT receipts_status_chk CHECK (status IN ('draft','posted','voided'))");
    await queryInterface.sequelize.query("ALTER TABLE receipts ADD CONSTRAINT receipts_method_chk CHECK (method IN ('cash','transfer','check','card','other'))");
    await queryInterface.sequelize.query("ALTER TABLE receipts ADD CONSTRAINT receipts_account_role_chk CHECK (account_role IN ('cash','bank'))");

    await queryInterface.createTable('receipt_lines', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      receipt_id: { type: Sequelize.CHAR(36), allowNull: false },
      receivable_id: { type: Sequelize.CHAR(36), allowNull: false },
      applied_cents: { type: Sequelize.BIGINT, allowNull: false },
    });
    // La misma partida no se aplica dos veces en el mismo recibo.
    await queryInterface.addIndex('receipt_lines', ['receipt_id', 'receivable_id'], { unique: true, name: 'receipt_lines_uq' });
    await queryInterface.addIndex('receipt_lines', ['organization_id', 'receivable_id'], { name: 'receipt_lines_receivable' });
    await queryInterface.sequelize.query('ALTER TABLE receipt_lines ADD CONSTRAINT receipt_lines_amount_chk CHECK (applied_cents > 0)');

    await queryInterface.createTable('receipt_advance_uses', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      receipt_id: { type: Sequelize.CHAR(36), allowNull: false },
      advance_id: { type: Sequelize.CHAR(36), allowNull: false },
      used_cents: { type: Sequelize.BIGINT, allowNull: false },
      // Anulado el recibo, el consumo se marca (no se borra) y el anticipo vuelve a tener ese saldo.
      reversed_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('receipt_advance_uses', ['receipt_id', 'advance_id'], { unique: true, name: 'receipt_advance_uses_uq' });
    await queryInterface.addIndex('receipt_advance_uses', ['organization_id', 'advance_id'], { name: 'receipt_advance_uses_advance' });
    await queryInterface.sequelize.query('ALTER TABLE receipt_advance_uses ADD CONSTRAINT receipt_advance_uses_amount_chk CHECK (used_cents > 0)');

    await queryInterface.createTable('receipt_sequences', {
      organization_id: { type: Sequelize.CHAR(36), allowNull: false, primaryKey: true },
      year: { type: Sequelize.INTEGER, allowNull: false, primaryKey: true },
      current_value: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
    });

    // Aplicaciones anuladas (recibo anulado): se marcan, no se borran. Toda suma las ignora.
    await queryInterface.addColumn('credit_applications', 'reversed_at', { type: Sequelize.DATE, allowNull: true });
    // Anticipo de un recibo anulado.
    await queryInterface.addColumn('customer_advances', 'voided_at', { type: Sequelize.DATE, allowNull: true });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('customer_advances', 'voided_at');
    await queryInterface.removeColumn('credit_applications', 'reversed_at');
    for (const table of ['receipt_sequences', 'receipt_advance_uses', 'receipt_lines', 'receipts']) {
      await queryInterface.dropTable(table);
    }
  },
};
