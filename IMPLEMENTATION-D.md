# IMPLEMENTATION-D — Tesorería, bloque D: cuentas por pagar y pagos a proveedores

Escrito 2026-10-22. Se construye **dentro de `backend/treasury-service`** (ya desplegado en producción, repo `facturero/treasury-service`, rama `main`), **en el mismo módulo** del catálogo `finance.accounts_receivable_payable` (ya `disponible`). Lee antes `IMPLEMENTATION.md` (§0.3 estado, §1 reglas) y `AGENTS.md` de la raíz: este documento **no repite** lo que allí ya está, solo lo que cambia para pagar en vez de cobrar.

## 0. Por qué dentro de `treasury-service` y no en otro proyecto

- **Mismo dominio y mismo módulo comprado:** el plugin se llama «por cobrar / por pagar». Un servicio nuevo repetiría repo, base, secretos, CI, k8s, gateway y plugin para nada.
- **Comparte lo caro:** salidas de caja y banco (`cash`/`bank`), numeración, outbox, consumidor de eventos, catálogos (contabilidad, organización), estado de cuenta, exportar, bitácora. La conciliación bancaria (bloque E) necesita cobros y pagos **en la misma base y la misma transacción**.
- **No va en `purchasing-service`:** compras es dueño de la factura de compra (el documento); pagarla es otro agregado y otro permiso. Compras publica `purchasing.bill.*`; tesorería lo consume, igual que consume `billing.invoice.*`.
- Dividir en plugin aparte (`finance.accounts_payable`) más adelante es barato (las reglas del gateway ya llevan `requiresPlugin` por ruta). **No se hace en este bloque.**

## 1. Estado de partida (verifícalo antes de empezar)

- Tesorería ya tiene: partidas por cobrar, cobros `RC-` (borrador → contabilizado → anulado), anticipos, aplicación por `credit_applications`, estado de cuenta, antigüedad, exportar CSV, recordatorios, saldos iniciales. **Espejo exacto de lo que se construye aquí:** `receipt-use-cases.ts`, `receivable-use-cases.ts`, `list-use-cases.ts`, `opening-balance-use-case.ts`, `export-use-cases.ts`. Léelos y copia el patrón (bloqueo ordenado, `READ COMMITTED`, `expectedVersion`, fechas sin hora, números al contabilizar).
- Compras publica (ver `backend/purchasing-service/asyncapi.yaml`): `purchasing.bill.posted` (trae `billId`, `internalNumber` FC-…, `supplierId`, `supplier{identification,legalName}`, `supplierDocument`, `issueDate`, **`dueDate`**, `currencyCode`, `totalCents`, `establishmentId`), `purchasing.bill.voided` (+`voidReason`). La retención la publica `fiscal-ecuador` como `fiscal.ec.withholding.issued` (`supplier.identification`, `support.documentCode`, `support.number`, `totalWithheldCents`, `incomeTaxWithheldCents`, `vatWithheldCents`); **no trae id de factura de compra**: se empareja por RUC + número del documento sustento (copia la lógica de `purchasing-service`, handler de ese evento).
- Contabilidad (`accounting-service`, `src/domain/posting.ts`) ya asienta la compra con `Cr payables` **con el proveedor como tercero** (`partyType: 'supplier'`, `partyId: supplierId`) y la retención con `Dr payables` (**sin tercero**: solo tiene el RUC). El rol `supplier_advances` («Anticipos a proveedores», `1.1.04.02`) ya existe en el plan de cuentas. **No hay asiento de pago**: es parte de este bloque.
- Facturas de compra **anteriores a `auto_posting_from`** de contabilidad no se asientan: tesorería debe aplicar los MISMOS filtros que `HandleInvoiceIssuedUseCase` (moneda base, fecha de arranque, `AccountingCatalogPort`) o el submayor nunca cuadrará con el mayor.

## 2. Modelo (migración nueva `20261023100000-create-payables.cjs`; no edites migraciones ya aplicadas)

- `payables`: espejo de `receivables` con `supplier_id`, `supplier_name`, `supplier_identification`, `source_type` (`purchase_bill` | `initial_balance`), `source_id`, `document_number` (la factura del proveedor `supplierDocument`), `internal_number` (FC-…), `issue_date`, `due_date` (viene del evento: **no hay días de crédito que calcular**), `original_cents`, `status` (`open|partial|paid|cancelled`), `version`. `UNIQUE (organization_id, source_type, source_id)`. **El saldo se deriva** (original − aplicado), nunca columna.
- `payable_applications`: lo que reduce una deuda: `source_type` (`payment` | `withholding`), `source_id`, `applied_cents`, `reversed_at`. `UNIQUE (organization_id, payable_id, source_type, source_id)`. Una retención y un pago se anulan con `reversed_at`, no se borran.
- `unmatched_withholdings`: retención llegada antes que su factura (RabbitMQ no ordena): se guarda y se aplica cuando llega `purchasing.bill.posted`. Una retención sin factura de compra en este módulo **se ignora** (casi todas lo son), pero con registro de que se ignoró; define y documenta el criterio (no la pierdas en silencio si la factura puede llegar después).
- `supplier_advances` (anticipos a proveedores: pagar de más o pagar sin factura) y `payment_advance_uses` (espejo de `receipt_advance_uses`).
- `payments` (`PG-AAAA-NNNNNN` al contabilizar, `payment_sequences`), `payment_lines` (partida, importe), con `method` (`cash|transfer|check|other`), `account_role` (`cash|bank`), `reference` obligatoria en transferencia y cheque, `check_number`/`bank` opcionales en cheque, `status` (`draft|approved|posted|voided`), `voided_*`, `approved_by`/`approved_at`. `CHECK (total_cents + advance_used_cents = applied_cents + advance_cents)`.
- `payment_settings` (una fila por organización): `approval_threshold_cents` (NULL = sin aprobación; **nace apagado**).
- Ninguna migración usa `service`/columnas que no existan (el catálogo falló una vez por eso): **aplícalas sobre MySQL real, dos veces y deshechas**.

## 3. Reglas propias de pagar (además de las de §1 de `IMPLEMENTATION.md`)

1. **Separación de funciones.** Quien crea el pago no lo aprueba; con `approval_threshold_cents` definido, un pago `≥` umbral exige estado `approved` por **otra persona** (`payment:approve`) para contabilizarse. Anular es solo Administrador, con motivo ≥ 5 caracteres. Prueba cada combinación.
2. **Nunca se paga de más una factura** (ni dos veces la misma partida en un pago) y **nunca se paga a un proveedor distinto del de la factura**. El saldo disponible ya descuenta la retención aplicada.
3. **Se paga lo NETO:** una factura de 115,00 con retención de 10,00 se paga 105,00. La retención reduce la deuda como una aplicación (`source_type = 'withholding'`).
4. **Contabilizar es idempotente y concurrente-seguro** (30 pagos a la misma deuda simultáneos: caben los que caben, sin interbloqueos, números sin saltos). Orden de bloqueo fijo: pago → partidas por id → anticipos por id → secuencia.
5. **Los datos de otro servicio se piden FUERA de la transacción** (HTTP): proveedor (`purchasing-service`, `GET /purchasing/suppliers/:id`, cabeceras `X-Organization-Id`, `X-User-Id`, `X-Permissions: supplier:read`; caído → 502, no existe → 422), moneda/huso/roles de contabilidad (`AccountingCatalogPort`).
6. **Cada escritura publica un evento en la MISMA transacción** (el guardián `audit-coverage.test.ts` lo exige). Eventos nuevos: `treasury.payable.opened|cancelled|credited`, `treasury.payment.created|updated|approved|posted|voided`, `treasury.payable_opening_balance.loaded`, `treasury.payment_settings.updated`, y `treasury.report.exported` con los reportes nuevos (`payables`, `payables_aging`, `supplier_statement`). Cada uno lleva en el payload **qué cambió** (proveedor, factura, importes, motivo, quién), documentado en `asyncapi.yaml`.
7. **Fechas de calendario (`AAAA-MM-DD`) jamás pasan por UTC** (`domain/dates.ts`).

## 4. Bloques y orden (cada casilla se marca solo con evidencia)

### D.1 Cuentas por pagar (deuda, antigüedad, estado de cuenta)
- [x] Migración y modelos de §2 (partidas, aplicaciones, retenciones sin emparejar).
- [x] Consumidores `purchasing.bill.posted` (abre partida si contabilidad la asentaría), `purchasing.bill.voided` (anula; lo ya pagado deja saldo a favor, como en cobros) y `fiscal.ec.withholding.issued` (aplica la retención). Idempotentes por `eventId` y por `UNIQUE`; tolerantes al desorden.
- [x] Rutas `GET /treasury/payables`, `/payables/:id`, `/payables/aging`, `/suppliers/:id/statement`, exportar CSV de cada una (**`payable:export`**, evento `treasury.report.exported`, mismas defensas del CSV de cobros: BOM, fórmulas neutralizadas, sin paginar). «Por vencer en 7 días» además de los tramos vencidos.
- [x] Saldos iniciales de deudas (`POST /treasury/payable-opening-balances`, permiso existente `opening_balance:load`, valida proveedores contra compras, **no genera asiento**: la pantalla lo avisa, igual que cartera).
- [x] `openapi.yaml` y `asyncapi.yaml` al día (`npm run verify:openapi`, `verify:asyncapi`).

### D.2 Pagos
- [x] Pagos `draft → (approved) → posted → voided`, aplicados a facturas (por antigüedad por defecto o a mano), anticipos a proveedores, `payment_settings` (umbral de aprobación, nace apagado), rutas bajo `/treasury/payments`.
- [x] **Asiento en `accounting-service`** (mismo patrón que `receipt.posted`: `draftFromPaymentPosted`, reversa al anular, pendientes si falta cuenta, idempotente, fecha en el huso de la organización):
  `Dr payables (proveedor como tercero) = aplicado` · `Dr supplier_advances (proveedor como tercero) = excedente` · `Cr supplier_advances = anticipo consumido` · `Cr cash|bank = lo que salió`. Tipos de origen nuevos `payment` y `payment_void` en las etiquetas de contabilidad y en la pantalla de asientos (es/en/fr). Pruebas de cuadre (debe = haber) y de reversa.
- [x] Contabilidad **no debe romperse** si recibe un evento de pago de una organización sin cuenta de banco/caja: queda en pendientes con motivo legible.

### R. Cableado transversal (mismo cambio que D.1/D.2, no «después»)
- [x] **auth-service:** migración nueva `20261023100000-add-treasury-payable-permissions.js` (mismo patrón que `20261021170000` y `20261022100000`: por NOMBRE de rol, `INSERT IGNORE`, un solo bump de `permissions_version`, idempotente, probada dos veces sobre MySQL real). Permisos: `payable:read` (Administrador, Supervisor, Contador, Solo lectura), `payable:export` (Administrador, Contador), `payment:read` (igual que `payable:read`), `payment:create` (Administrador, Contador: crear, editar borrador y contabilizar), `payment:approve` (solo Administrador: aprobar y cambiar el umbral), `payment:void` (solo Administrador). Ningún permiso «de adorno»: `node scripts/check-permissions.mjs --strict` en verde.
- [x] **api-gateway-node:** una regla por método y ruta (plugin `finance.accounts_receivable_payable` + permiso), **sin comodín final** y con `:id` (un segmento, nunca `*`); las rutas `export`/`aging` ANTES de `/:id`. Pruebas en `treasury-routes.test.ts`, incluida la mutación (reintroducir un comodín debe hacer fallar una prueba). `maxBodyBytes` en las de escritura.
- [x] **Bitácora:** etiquetas es/en/fr de cada evento nuevo (`audit.event.treasury_payable_opened`, …) y su ícono/color en `AuditLogView.vue`; `frontend/scripts/check-audit-labels.mjs` y `npm run lint:ui` en verde.
- [x] **Frontend** (`docs/UI-UX.md`: `PageHeader`, sin hexadecimales, sin `text-h1…h4`, íconos válidos, ancho completo): pestañas «Por pagar» y «Pagos» en `TreasuryTabs`, rutas `/treasury/payables`, `/treasury/payables/aging`, `/treasury/suppliers/:id/statement`, `/treasury/payments`, `/treasury/payments/new|:id|:id/edit`; formulario de pago con reparto automático por antigüedad, resumen vivo, «Guardar borrador» / «Aprobar» / «Pagar» según el estado y los permisos; imprimir y exportar CSV; es/en/fr completos. **El Contador no tiene `supplier:read`** (no puede listar proveedores): el selector de proveedor debe ofrecer a los que tienen deuda, como ya hace el de clientes.
- [x] **Docs:** `IMPLEMENTATION.md` §0.3 (estado y defectos hallados), `COSAS-POR-HACER.md` (orden de subida y lo del dueño), `PLAN-ERP.md` (Avance), `backend/treasury-service/README`/asyncapi/openapi.

## 5. Verificación (las tres capas; «las pruebas pasan» no basta)

1. **Unitarias:** dominio, casos de uso con repos en memoria (aislamiento entre organizaciones, concurrencia por `version`, fallo a medias sin basura, desorden de eventos, duplicados), HTTP con permiso por ruta, 422 con nombre de campo, sin `X-Permissions: *`. La unidad de trabajo en memoria **no sirve para probar concurrencia real** (el rollback restaura una copia): eso va en la capa 2.
2. **MySQL y RabbitMQ reales:** `scripts/verify-payments.mjs` (modelo: `verify-receipts.mjs` y `verify-reminders.mjs`): 30 pagos simultáneos a una deuda, retención que llega antes y después de la factura, anticipos, anular, y **la prueba de oro**: para proveedores sin retención, el neto por proveedor de tesorería = saldo de `payables` de ese proveedor en el libro mayor; y, **en total**, suma de netos de tesorería = saldo total de `payables` de contabilidad (la retención se asienta sin tercero: no compares por proveedor los que tengan retención; deja esa limitación escrita). Por el gateway real.
3. **Navegador:** `scripts/local-stack/ui-pagos.cjs` (modelo: `ui-cobros.cjs`, `ui-recordatorios.cjs`) con Administrador, Contador y Vendedor, es/en/fr **realmente aplicados** y 390 px. Trampas ya vividas: (a) `addInitScript` que fija el idioma en cada navegación deja la prueba en español: fija solo si no hay idioma; (b) exige el **encabezado** de la pantalla antes de dar por buena una comprobación negativa (una página en blanco pasa «sin claves sin traducir»); (c) el gateway local limita las peticiones por minuto: súbelo con `RATE_LIMIT_MAX` al levantarlo; (d) tesorería valida contra los catálogos: usa un proveedor que exista.
- Antes de dar algo por terminado: `npm test`, `npm run typecheck`, `verify:openapi`, `verify:asyncapi`, los `verify-*.mjs`, y en `frontend/`: `npm run typecheck`, `npm test`, `npm run lint:ui` (y la variante `git ls-files -co` para archivos nuevos), `npm run build`. Backend de accounting, auth y gateway: sus suites completas.

## 6. Orden de despliegue (lo ejecuta el dueño, no tú)

`auth-service` (migración de permisos) → `accounting-service` (asiento de pago) → `treasury-service` (migración nueva por su initContainer) → `api-gateway-node` → `frontend`. Compras y el catálogo de plugins **no cambian**. Con `approval_threshold_cents` en NULL, un despliegue no puede cambiar el comportamiento de nada existente.

## 7. Fuera de alcance (a propósito)

Lotes de pago y archivo bancario por banco, impresión de cheques, programación de pagos, multimoneda, conciliación bancaria (bloque E), tercero en el asiento de la retención (cambio de `accounting-service` y de cómo fiscal identifica al proveedor), y tocar `purchasing-service` salvo que un contrato de evento lo exija (en ese caso, para y pregunta).

## 8. Qué se hizo distinto de lo escrito arriba (y por qué)

- **Antigüedad de lo que se debe:** no hay pantalla `/treasury/payables/aging` aparte. Las seis tarjetas (por vencer en 7 días, corriente y los tramos
  vencidos) viven arriba de «Por pagar», con su botón de exportar; la ruta de la API sí existe (`GET /treasury/payables/aging` y `/aging/export`).
- **`requiresApproval` en cada pago:** el Contador no puede LEER el umbral de aprobación (es del Administrador), así que su pantalla le ofrecía
  «Pagar» sobre un pago que el servidor iba a rechazar. Todo pago de una sola respuesta lleva ahora `requiresApproval` (sí/no, nunca el importe del
  umbral). Lo encontró la prueba por interfaz con tres roles; ninguna prueba unitaria lo veía.
- **Deudas «fantasma»:** una anulación de factura que llega ANTES que la factura deja una deuda ya anulada, sin proveedor, para que la factura posterior no
  abra nada (igual que en cartera). No es deuda: ningún listado ni reporte la cuenta.
- **Retención sin factura todavía:** con RUC y número de sustento válidos se guarda en `unmatched_withholdings` y se aplica cuando llega la factura;
  sin RUC/sustento válido, o con un sustento que no es factura de compra, se IGNORA. Una retención de una compra que nunca pasó por este módulo se queda
  esperando para siempre: es una fila pequeña por retención (decisión consciente; un barrido de las muy viejas es trabajo de un bloque posterior).
- **No recorta la retención al saldo:** contabilidad asienta `Dr proveedores` por el total retenido, así que si la deuda ya estaba pagada la retención
  deja el saldo a favor de la empresa (negativo), que es lo que dice el libro mayor.
- **Prueba de oro:** exacta por proveedor para quien no tiene retención; para quien la tiene, `neto de tesorería + retenido = libro mayor con su
  tercero`, porque contabilidad asienta la retención SIN tercero (solo trae el RUC). Cambiarlo exige tocar contabilidad y cómo fiscal identifica al
  proveedor: fuera de este bloque, queda anotado.
- **Pagos sin lotes ni archivo bancario ni impresión de cheques:** fuera de alcance (§7).
