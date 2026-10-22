'use strict';

/**
 * Tesorería, bloque E: bancos, extractos y conciliación.
 *
 * Decisiones de esquema:
 *  - `bank_movements` es el REGISTRO de bancos de tesorería: un renglón por cobro o pago contabilizado por BANCO y por ajuste bancario, con el
 *    importe CON SIGNO (+ entra, − sale). `UNIQUE (organization_id, source_type, source_id)` es la idempotencia: contabilizar dos veces no lo duplica.
 *    Anular un cobro/pago lo marca `reversed` (no se borra: la bitácora lo explica).
 *  - Los movimientos de cobros y pagos que YA estaban contabilizados por banco se rellenan aquí mismo, sin cuenta asignada
 *    (`bank_account_id` NULL): no entran en ninguna conciliación hasta que alguien les asigna su cuenta.
 *  - El número de cuenta completo NO se guarda: solo los últimos 4 dígitos (`account_last4`).
 *  - `bank_statements.content_hash` es único por cuenta: el mismo archivo no se importa dos veces. `bank_statement_lines.fingerprint`
 *    (huella + ocurrencia) es único por cuenta: los extractos que se solapan no duplican renglones.
 *  - `bank_matches.movement_id` es único: un movimiento solo está emparejado con un renglón. Un renglón puede tener varios movimientos
 *    (un depósito de varios cobros); la suma debe igualar el importe del renglón (lo comprueba el caso de uso con las filas bloqueadas).
 *  - `reconciliation_id` en renglones y emparejamientos los congela cuando se cierra la conciliación.
 *  - La conciliación se calcula EN VIVO (no hay borrador guardado): solo se persiste al CERRARla. Reabrir la última de una cuenta la marca `reopened`
 *    (queda como historia) y descongela sus renglones.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('bank_accounts', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      name: { type: Sequelize.STRING(80), allowNull: false },
      bank_name: { type: Sequelize.STRING(120), allowNull: false },
      // checking | savings
      account_type: { type: Sequelize.STRING(10), allowNull: false },
      account_last4: { type: Sequelize.STRING(4), allowNull: true },
      currency_code: { type: Sequelize.CHAR(3), allowNull: false },
      opening_balance_cents: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      opening_date: { type: Sequelize.DATEONLY, allowNull: false },
      is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      import_profile: { type: Sequelize.JSON, allowNull: true },
      version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('bank_accounts', ['organization_id', 'name'], { unique: true, name: 'bank_accounts_org_name_uq' });

    await queryInterface.createTable('bank_movements', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      bank_account_id: { type: Sequelize.CHAR(36), allowNull: true },
      // receipt | payment | adjustment
      source_type: { type: Sequelize.STRING(12), allowNull: false },
      source_id: { type: Sequelize.CHAR(36), allowNull: false },
      movement_date: { type: Sequelize.DATEONLY, allowNull: false },
      // Con signo: + entra, − sale.
      amount_cents: { type: Sequelize.BIGINT, allowNull: false },
      reference: { type: Sequelize.STRING(100), allowNull: true },
      description: { type: Sequelize.STRING(300), allowNull: false },
      // bank_fee | interest | other_in | other_out (solo ajustes)
      kind: { type: Sequelize.STRING(12), allowNull: true },
      // active | reversed
      status: { type: Sequelize.STRING(10), allowNull: false },
      created_by: { type: Sequelize.CHAR(36), allowNull: true },
      version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('bank_movements', ['organization_id', 'source_type', 'source_id'], { unique: true, name: 'bank_movements_org_source_uq' });
    await queryInterface.addIndex('bank_movements', ['organization_id', 'bank_account_id', 'status', 'movement_date'], { name: 'bank_movements_account' });
    await queryInterface.sequelize.query('ALTER TABLE bank_movements ADD CONSTRAINT bank_movements_amount_ck CHECK (amount_cents <> 0)');

    await queryInterface.createTable('bank_statements', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      bank_account_id: { type: Sequelize.CHAR(36), allowNull: false },
      file_name: { type: Sequelize.STRING(200), allowNull: true },
      content_hash: { type: Sequelize.CHAR(64), allowNull: false },
      period_start: { type: Sequelize.DATEONLY, allowNull: false },
      period_end: { type: Sequelize.DATEONLY, allowNull: false },
      line_count: { type: Sequelize.INTEGER, allowNull: false },
      closing_balance_cents: { type: Sequelize.BIGINT, allowNull: true },
      closing_date: { type: Sequelize.DATEONLY, allowNull: true },
      imported_by: { type: Sequelize.CHAR(36), allowNull: false },
      imported_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('bank_statements', ['organization_id', 'bank_account_id', 'content_hash'], { unique: true, name: 'bank_statements_hash_uq' });

    await queryInterface.createTable('bank_statement_lines', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      bank_account_id: { type: Sequelize.CHAR(36), allowNull: false },
      statement_id: { type: Sequelize.CHAR(36), allowNull: false },
      line_date: { type: Sequelize.DATEONLY, allowNull: false },
      description: { type: Sequelize.STRING(300), allowNull: false },
      reference: { type: Sequelize.STRING(80), allowNull: true },
      amount_cents: { type: Sequelize.BIGINT, allowNull: false },
      balance_cents: { type: Sequelize.BIGINT, allowNull: true },
      // sha256 (64) + ':' + ocurrencia
      fingerprint: { type: Sequelize.STRING(80), allowNull: false },
      // unmatched | matched | external
      status: { type: Sequelize.STRING(10), allowNull: false },
      external_reason: { type: Sequelize.STRING(300), allowNull: true },
      reconciliation_id: { type: Sequelize.CHAR(36), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('bank_statement_lines', ['organization_id', 'bank_account_id', 'fingerprint'], { unique: true, name: 'bank_lines_fingerprint_uq' });
    await queryInterface.addIndex('bank_statement_lines', ['organization_id', 'bank_account_id', 'status', 'line_date'], { name: 'bank_lines_account' });
    await queryInterface.addIndex('bank_statement_lines', ['reconciliation_id'], { name: 'bank_lines_reconciliation' });

    await queryInterface.createTable('bank_matches', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      bank_account_id: { type: Sequelize.CHAR(36), allowNull: false },
      line_id: { type: Sequelize.CHAR(36), allowNull: false },
      movement_id: { type: Sequelize.CHAR(36), allowNull: false },
      amount_cents: { type: Sequelize.BIGINT, allowNull: false },
      // manual | suggested
      method: { type: Sequelize.STRING(10), allowNull: false },
      matched_by: { type: Sequelize.CHAR(36), allowNull: false },
      matched_at: { type: Sequelize.DATE, allowNull: false },
      reconciliation_id: { type: Sequelize.CHAR(36), allowNull: true },
    });
    await queryInterface.addIndex('bank_matches', ['organization_id', 'movement_id'], { unique: true, name: 'bank_matches_movement_uq' });
    await queryInterface.addIndex('bank_matches', ['organization_id', 'line_id'], { name: 'bank_matches_line' });
    await queryInterface.addIndex('bank_matches', ['reconciliation_id'], { name: 'bank_matches_reconciliation' });

    await queryInterface.createTable('bank_reconciliations', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      bank_account_id: { type: Sequelize.CHAR(36), allowNull: false },
      cutoff_date: { type: Sequelize.DATEONLY, allowNull: false },
      statement_balance_cents: { type: Sequelize.BIGINT, allowNull: false },
      register_balance_cents: { type: Sequelize.BIGINT, allowNull: false },
      pending_cents: { type: Sequelize.BIGINT, allowNull: false },
      difference_cents: { type: Sequelize.BIGINT, allowNull: false },
      // closed | reopened
      status: { type: Sequelize.STRING(10), allowNull: false },
      closed_by: { type: Sequelize.CHAR(36), allowNull: true },
      closed_at: { type: Sequelize.DATE, allowNull: true },
      reopened_by: { type: Sequelize.CHAR(36), allowNull: true },
      reopened_at: { type: Sequelize.DATE, allowNull: true },
      notes: { type: Sequelize.STRING(500), allowNull: true },
      version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      created_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('bank_reconciliations', ['organization_id', 'bank_account_id', 'cutoff_date'], { name: 'bank_reconciliations_account' });

    // Cobros y pagos eligen su cuenta bancaria (opcional: el efectivo no la lleva).
    await queryInterface.addColumn('receipts', 'bank_account_id', { type: Sequelize.CHAR(36), allowNull: true });
    await queryInterface.addColumn('payments', 'bank_account_id', { type: Sequelize.CHAR(36), allowNull: true });

    // Relleno: lo que ya se cobró y pagó por banco queda en el registro, sin cuenta asignada. Idempotente por el UNIQUE de origen.
    await queryInterface.sequelize.query(`
      INSERT IGNORE INTO bank_movements
        (id, organization_id, bank_account_id, source_type, source_id, movement_date, amount_cents, reference, description, kind, status, created_by, version, created_at, updated_at)
      SELECT UUID(), r.organization_id, NULL, 'receipt', r.id, r.receipt_date, r.total_cents, r.reference, r.customer_name, NULL, 'active', r.posted_by, 1, NOW(), NOW()
      FROM receipts r WHERE r.status = 'posted' AND r.account_role = 'bank' AND r.total_cents > 0
    `);
    await queryInterface.sequelize.query(`
      INSERT IGNORE INTO bank_movements
        (id, organization_id, bank_account_id, source_type, source_id, movement_date, amount_cents, reference, description, kind, status, created_by, version, created_at, updated_at)
      SELECT UUID(), p.organization_id, NULL, 'payment', p.id, p.payment_date, -p.total_cents, p.reference, p.supplier_name, NULL, 'active', p.posted_by, 1, NOW(), NOW()
      FROM payments p WHERE p.status = 'posted' AND p.account_role = 'bank' AND p.total_cents > 0
    `);
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('payments', 'bank_account_id');
    await queryInterface.removeColumn('receipts', 'bank_account_id');
    for (const table of ['bank_reconciliations', 'bank_matches', 'bank_statement_lines', 'bank_statements', 'bank_movements', 'bank_accounts']) {
      await queryInterface.dropTable(table);
    }
  },
};
