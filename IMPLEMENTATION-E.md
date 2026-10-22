# IMPLEMENTATION — Bloque E de tesorería: bancos, extractos y conciliación

Hoja de trabajo (2026-10-22). Va **dentro de `treasury-service`**, en el mismo módulo `finance.accounts_receivable_payable`: no hay servicio ni módulo nuevo.
Lo que ya existe y se reutiliza: cobros (`receipts`) y pagos (`payments`) con `accountRole` `cash|bank`; asiento por roles en `accounting-service`
(`bank`, `other_expense`, `other_income` ya existen: **no hace falta ningún rol nuevo**); cartera y deuda con vencimientos (para el flujo de caja).

## 1. Decisiones (y por qué)

1. **Un «registro de bancos» propio de tesorería** (`bank_movements`): cada cobro o pago contabilizado por BANCO (`accountRole = 'bank'`) deja un
   movimiento en la MISMA transacción que lo contabiliza, y anularlo lo marca revertido. No se lee el libro mayor de contabilidad: acoplaría la
   conciliación a otro servicio y a todos los asientos que no son de tesorería.
2. **Varias cuentas bancarias, un solo rol contable.** Contabilidad resuelve `bank` a UNA cuenta del plan. Las cuentas bancarias de tesorería
   (Pichincha, Guayaquil…) se distinguen en tesorería; en el libro mayor todas suman en esa cuenta. Separarlas en el mayor es un cambio de contabilidad
   (una cuenta por banco) que **no** se hace aquí. Límite anotado.
3. **Saldo de apertura por cuenta.** `opening_balance_cents` a `opening_date`: cuenta solo lo posterior a esa fecha (movimientos y renglones del extracto).
   Es la forma de empezar sin arrastrar la historia.
4. **No se inventa el formato de ningún banco.** Cada cuenta guarda un **perfil de importación** (delimitador, filas de encabezado, columnas, formato de
   fecha, separador decimal, importe con signo o débito/crédito). Se importa con **vista previa**: errores por fila antes de guardar nada.
5. **Importar es idempotente.** El mismo archivo (hash del contenido normalizado) no entra dos veces; los renglones repetidos entre extractos que se
   solapan se detectan por huella (fecha, importe, referencia, descripción) + ocurrencia, y se omiten contados.
6. **Emparejar = renglón del extracto ↔ uno o varios movimientos**, mismo signo y suma exacta (un depósito de varios cobros). **Nada se empareja solo
   sin confirmar:** el sistema SUGIERE (importe exacto + referencia o fecha cercana, y solo si el candidato es único) y una persona confirma.
7. **«Ya contabilizado fuera de tesorería»:** una venta cobrada en el momento con tarjeta o transferencia se asienta en contabilidad al emitir la factura
   (nunca pasa por un cobro de tesorería). Ese renglón del extracto se marca `external` con un motivo obligatorio y cuenta en el lado del registro. Es
   una afirmación de la persona, no una verificación: queda en la bitácora.
8. **Ajustes bancarios** (comisión, interés, otro ingreso/egreso): lo que el banco hizo y la empresa no registró. Son movimientos de tesorería que
   **publican `treasury.bank_adjustment.posted|voided`** y contabilidad los asienta (egreso → `other_expense` / ingreso → `other_income`, contra `bank`).
9. **Conciliación a una fecha de corte:** `diferencia = saldo del extracto − (saldo del registro − movimientos pendientes)`. Solo se **cierra** con
   diferencia 0 y sin renglones sin resolver hasta esa fecha. Cerrar congela los emparejamientos; anular un cobro/pago ya conciliado se rechaza (409)
   hasta reabrir la conciliación (solo la última cerrada de cada cuenta, se puede reabrir).
10. **Flujo de caja proyectado** (solo lectura, derivado): saldo actual de bancos + cartera por vencimiento − deuda por vencimiento, en semanas.
    Lo vencido cae en la primera columna («vencido / ya»). No toca asientos.

## 2. Modelo de datos (migración `20261024100000-create-banking.cjs`)

- `bank_accounts`: nombre (único por org), banco, tipo (`checking|savings`), terminación (últimos 4 dígitos; **nunca** el número completo), moneda,
  `opening_balance_cents` + `opening_date`, `is_active`, `import_profile` (JSON), versión.
- `receipts.bank_account_id` y `payments.bank_account_id` (nulos): se eligen al crear el borrador cuando el medio no es efectivo.
- `bank_movements`: `source_type` `receipt|payment|adjustment`, `source_id`, `bank_account_id` (nulo = sin asignar), `movement_date`, `amount_cents`
  **con signo** (+ entra, − sale), `reference`, `description`, `kind` (solo ajustes), `status active|reversed`, `reconciliation_id`. `UNIQUE (org, source_type,
  source_id)`: idempotencia. La migración **rellena** desde los cobros/pagos por banco ya contabilizados (sin cuenta asignada).
- `bank_statements` (archivo importado: hash único por cuenta, periodo, saldos si el archivo los trae) y `bank_statement_lines` (fecha, descripción,
  referencia, importe con signo, saldo, huella única por cuenta + ocurrencia, `status unmatched|matched|external`, `external_reason`, `reconciliation_id`).
- `bank_matches`: `(line_id, movement_id)`, `UNIQUE (movement_id)`, quién y cómo (`manual|suggested`), `reconciliation_id` cuando se congela.
- `bank_reconciliations`: cuenta, fecha de corte, saldo del extracto, saldo del registro, pendientes, diferencia, `draft|closed`, quién cerró.

## 3. Permisos (migración de auth `20261024100000`)

`bank_account:read` (cuentas, extractos, conciliación, flujo de caja), `bank_account:manage` (crear/editar cuentas, perfil, importar, asignar cuenta a
un movimiento), `reconciliation:manage` (emparejar, marcar externo, ajustes bancarios, cerrar y reabrir). Administrador y Contador: todos; Vendedor: ninguno.
Flujo de caja: `bank_account:read`.

## 4. Casillas

- [x] Migración, modelos, repositorios en memoria **y** Sequelize.
- [x] Dominio puro con pruebas: perfil e importación CSV, huella, emparejamiento/sugerencias, conciliación (`reconcile`), flujo de caja.
- [x] Cobros y pagos: `bankAccountId` + movimiento al contabilizar/anular (misma transacción); anular conciliado → 409.
- [x] Casos de uso: cuentas, vista previa/importar, listar, sugerir, emparejar/desemparejar, externo, ajustes, asignar cuenta, conciliar/cerrar/reabrir, flujo de caja, exportar.
- [x] Rutas + `openapi.yaml` + `asyncapi.yaml` (guardianes verdes).
- [x] **accounting-service:** asiento del ajuste bancario y su reversa (+ pruebas, asyncapi).
- [x] **auth-service:** migración de permisos. **Gateway:** una regla por método. **Bitácora:** etiquetas es/en/fr.
- [x] **Frontend:** Bancos (cuentas + perfil), importar con vista previa, conciliación, flujo de caja; es/en/fr; `lint:ui` y build.
- [x] Verificación en vivo (`scripts/verify-banking.mjs`) y por interfaz (`ui-bancos.cjs`); docs.

## 5. Qué se hizo distinto de lo escrito arriba (y por qué)

- **No hay conciliación «en borrador».** La conciliación se calcula EN VIVO a una fecha de corte (`GET …/reconciliation`) y solo se guarda al cerrarla.
  Sus estados son `closed` y `reopened` (la reabierta queda como historia). Un borrador guardado no aportaba nada y dejaba una fila que podía
  quedar vieja respecto a los emparejamientos.
- **El movimiento no lleva `reconciliation_id`:** que está congelado lo dice su emparejamiento (`bank_matches.reconciliation_id`), que se congela con su renglón.
- **Permisos:** `bank_account:read` cubre también el flujo de caja y su exportación (no hay `cash_flow:read`: sería un permiso de adorno).
  El Supervisor y el Vendedor no ven bancos: el saldo del banco es información sensible. «Solo lectura» sí.
- **`treasury.bank_movement.reversed` solo se publica cuando anular un cobro, pago o ajuste DESHIZO un emparejamiento.** Lo demás ya lo dice la anulación
  del documento: publicarlo siempre habría duplicado cada anulación en la bitácora.
- **Todo lo que muta el estado bancario toma el bloqueo en el mismo orden: cuenta → renglón → movimiento** (emparejar, deshacer, ajustes, cerrar, reabrir y
  también anular un cobro o pago por banco). Es lo que impide interbloqueos entre quien empareja y quien anula, y lo que hace que cerrar una
  conciliación no se cruce con un cambio a medias.
- **El importe de apertura y su fecha** se fijan al crear la cuenta y no cambian cuando ya hay extractos o conciliaciones.
- **Un renglón nuevo de un periodo ya conciliado no entra** (el archivo se rechaza con el motivo): importarlo cambiaría en silencio una conciliación cerrada.
  Un ajuste fechado dentro de lo conciliado tampoco.
- **El extracto viaja como texto dentro del JSON** (el navegador lo lee con `File.text()`, UTF-8): el gateway admite 4 MB solo en las dos rutas de extractos
  (el resto de bancos, 16–32 KB). Un CSV en Latin-1 mostraría mal los acentos: se guarda tal como llega.
- **Frontend:** con UNA sola cuenta activa, los cobros y pagos nuevos la eligen solos; sin permiso de ver bancos el selector no aparece y el movimiento
  queda «sin asignar».

### Límites conocidos (anotados, no son errores)

1. **Varias cuentas bancarias, una sola cuenta del mayor.** Contabilidad resuelve el rol `bank` a UNA cuenta del plan: el libro mayor suma todos los
   bancos juntos. La prueba de oro compara el registro de TODAS las cuentas (y lo sin asignar) contra «Bancos». Separarlas en el mayor es trabajo de contabilidad.
2. **Las transferencias entre cuentas propias no existen todavía:** se registran hoy como un ajuste de salida en una cuenta y de entrada en la otra (queda
   contra otros gastos y otros ingresos, no neto). Un bloque posterior las modela.
3. **Una venta cobrada con tarjeta o transferencia al emitir la factura** se asienta en contabilidad sin pasar por tesorería. Su renglón del extracto se
   marca «contabilizado fuera de tesorería»: es una AFIRMACIÓN de la persona (con motivo y en la bitácora), no una verificación contra el mayor.
4. **Solo CSV en UTF-8.** No hay OFX, MT940 ni conexión directa con el banco.
5. **La conciliación carga los movimientos, renglones y emparejamientos de la cuenta** (no por páginas): bien hasta decenas de miles; más allá habría que
   congelar por periodos y no volver a leer lo viejo.
6. **Las facturas de compra y los cobros anteriores a este módulo** llegan sin cuenta (la migración los rellena en `bank_movements` sin asignar): hay que
   asignarles una antes de conciliar.

## 6. Evidencia (2026-10-23, en local, sin subir)

- **477 pruebas** en `treasury-service` (28 del dominio puro, 39 de casos de uso, 30 por HTTP; guardianes de bitácora y de contrato en verde: openapi 61
  rutas, asyncapi 37 eventos publicados y 5 consumidos). **242** en contabilidad (14 del asiento del ajuste bancario), 259 en auth, 188 en el gateway,
  431 en el frontend; `check-permissions --strict` y `lint:ui` (137 componentes, 87 eventos con etiqueta en es/en/fr) en verde.
- **`scripts/verify-banking.mjs` contra MySQL y RabbitMQ reales:** la migración se aplica, se deshace y se rehace (rellena 4 cobros y 10 pagos); 10 renglones
  iguales por UN movimiento a la vez → exactamente un emparejamiento y nueve 409; emparejar y anular el mismo cobro a la vez, 12 rondas, sin 500 y sin
  emparejamientos huérfanos; el SQL real del filtro «emparejado / pendiente» y del congelado al cerrar; los ajustes llegan a contabilidad
  (Dr otros gastos / Cr bancos y al revés) y su anulación los reversa; **prueba de oro: lo que se movió en el registro de bancos = lo que se movió en «Bancos» del libro mayor.**
- **`scripts/local-stack/ui-bancos.cjs`** por la interfaz con Administrador, Contador y Vendedor (crear cuenta con perfil, importar con vista previa,
  archivo repetido y fila mala, sugerencias, ajuste, «fuera de tesorería», cerrar, reabrir, flujo de caja y su CSV, es/en/fr, 390 px).
- La verificación en vivo **no encontró defectos del servidor**; los fallos que salieron fueron de las propias pruebas (un recuento mal hecho, `fetch().text()`
  que se come el BOM, un campo con `maxlength` que ya impedía lo que se quería probar) y un riesgo de revisión: un `watch` sobre un `computed` declarado
  MÁS ABAJO habría fallado al montar la pantalla (`vue-tsc` no avisa de eso); se movió detrás del `computed`.
