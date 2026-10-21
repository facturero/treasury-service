'use strict';

/**
 * Tesorería, bloque C: recordatorios de cobro a clientes con deuda vencida.
 *
 *  - `reminder_settings`: UNA fila por organización. `enabled` nace en FALSE y solo lo enciende el Administrador: un recordatorio es
 *    comunicación externa (le llega un correo al CLIENTE de la organización), así que nunca sale sin esa decisión explícita.
 *  - `receivable_reminders`: un registro por (partida, día) en que se avisó. `UNIQUE (receivable_id, reminder_date)` es la idempotencia
 *    del proceso diario: si corre dos veces el mismo día (reinicio, dos réplicas, «enviar ahora») la segunda inserción falla y esa
 *    partida no se avisa otra vez. «Una vez por semana como máximo» se decide leyendo la última fecha de esta tabla.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('reminder_settings', {
      organization_id: { type: Sequelize.CHAR(36), primaryKey: true },
      enabled: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      // Días de atraso a partir de los cuales se avisa por primera vez.
      first_after_days: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 3 },
      // Cada cuántos días se repite el aviso de una misma partida (mínimo 7: un recordatorio por semana como máximo).
      repeat_every_days: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 7 },
      // Último día (local de la organización) en que el proceso diario corrió: evita repetir el barrido entero.
      last_run_on: { type: Sequelize.DATEONLY, allowNull: true },
      updated_by: { type: Sequelize.CHAR(36), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.sequelize.query(
      'ALTER TABLE reminder_settings ADD CONSTRAINT reminder_settings_days_ck CHECK (first_after_days BETWEEN 1 AND 90 AND repeat_every_days BETWEEN 7 AND 60)',
    );

    await queryInterface.createTable('receivable_reminders', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      receivable_id: { type: Sequelize.CHAR(36), allowNull: false },
      customer_id: { type: Sequelize.CHAR(36), allowNull: false },
      // Día local de la organización (sin hora): nunca se pasa por UTC.
      reminder_date: { type: Sequelize.DATEONLY, allowNull: false },
      // scheduled = proceso diario; manual = «enviar ahora» de una persona.
      trigger_kind: { type: Sequelize.STRING(10), allowNull: false },
      sent_by: { type: Sequelize.CHAR(36), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('receivable_reminders', ['receivable_id', 'reminder_date'], { unique: true, name: 'receivable_reminders_day_uq' });
    await queryInterface.addIndex('receivable_reminders', ['organization_id', 'customer_id'], { name: 'receivable_reminders_org_customer' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('receivable_reminders');
    await queryInterface.dropTable('reminder_settings');
  },
};
