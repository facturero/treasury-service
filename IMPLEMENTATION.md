# treasury-service — Tesorería (Fase 3 del plan ERP)

Hoja de trabajo para el agente de código. Escrita **2026-10-21**. **Estado: bloques A y R construidos y verificados en local (ver «Estado de la ejecución» más abajo); B, C, D y E sin empezar; nada desplegado.**
Empieza por el bloque 0 y avanza en orden; **no marques un bloque como terminado sin la evidencia de su casilla** (salida de la suite,
captura, número de asiento, evento en la bitácora). Lo que no pudiste comprobar queda sin marcar, con el motivo.

Este documento **no sustituye** a dos que ya existen y que sigues cumpliendo:

- `IMPLEMENTATION-erp-fase-3.md` (raíz): el diseño de negocio de tesorería (qué es una partida, el recibo, el asiento del cobro).
  Aquí está **traducido a pasos con ficheros exactos** y con lo aprendido después.
- `IMPLEMENTATION-erp-fase-2.md` §0–§1 y `AGENTS.md`: reglas y contrato transversal. Lo esencial se repite en §1 de esta hoja porque
  es lo que más se incumple; si hay conflicto, manda lo más estricto.

Para saber cómo se hace cada cosa, **copia `backend/purchasing-service`** (misma plantilla: Hono + Sequelize + Clean Architecture +
outbox + vitest + `openapi.yaml`/`asyncapi.yaml` + `k8s/`). Referencia de dónde vive cada pieza: §12.

---

## 0. Datos del servicio y decisiones tomadas

| Dato | Valor |
|---|---|
| Carpeta / repo | `backend/treasury-service` / `facturero/treasury-service` (por crear por el dueño) |
| Rama principal | **`main`** (un push despliega a producción) |
| Puerto / base | **3018** / `treasury_db` (usuario `treasury_user`, `GRANT` solo a su base) |
| Módulo (plugin) | `finance.accounts_receivable_payable` — 7,99 USD/mes, ya con precio en `plugins-precios.json` (799) |
| Numeración | recibos `RC-AAAA-NNNNNN`; pagos `PG-AAAA-NNNNNN` (bloque D). Contador propio por (organización, año), `UNIQUE (organization_id, number)` |
| Servicio K8s / URL interna | `treasury-service-node` / `http://treasury-service-node:3018` |

### 0.1 Decisiones del dueño (§7 de `IMPLEMENTATION-erp-fase-3.md`)

El 2026-10-21 el asistente propuso las cuatro respuestas por defecto y el dueño dio el visto bueno para empezar con ellas
(«bien, crea la carpeta…»). **No son definitivas**: si el dueño las cambia, se ajusta el bloque que dice cada una.

1. **Crédito:** días por defecto **0** (contado) y **sin cupo**; se configura por cliente (`customer_terms`).
2. **Anticipos:** **sí** se puede cobrar de más; el excedente queda como anticipo del cliente (`customer_advances`) y se aplica después.
3. **Saldos iniciales de cartera:** los carga el **Administrador**, con la **fecha de corte** que diga el dueño (idealmente la de
   puesta en marcha). La cartera nace **vacía**: las facturas ya emitidas no se recuperan solas (no hay endpoint de reproducción).
4. **Notas de crédito:** **restan** de lo que debe el cliente; si aún no tenía factura, quedan como **saldo a favor** y se aplican después.

### 0.2 Dependencias del módulo en el catálogo

Hoy `finance.accounts_receivable_payable` depende solo de `finance.electronic_invoicing`. **Debe depender también de
`finance.general_ledger`** (sus cobros y pagos generan asientos; sin contabilidad activa quedarían todos en «Pendientes»). La arista
inversa (contabilidad → cobros y pagos) **ya se quitó** en `20261015110000-enable-general-ledger.cjs`: no la restaures.

### 0.3 Estado de la ejecución (2026-10-21)

**Construido y verificado en local, sin commit ni push.** Lo hizo en parte opencode (servicio base, migraciones, permisos, módulo, gateway) y
en parte quien revisó su trabajo (pruebas, saneamiento del gateway, validación de clientes, bitácora, frontend). La revisión encontró y
corrigió **seis defectos reales** que ninguna suite de las que traía el trabajo veía; están listados para que no se repitan.

| Bloque | Estado | Evidencia |
|---|---|---|
| 0.2 esqueleto, compose, `k8s/`, CI, `init.sql` | Hecho | `npm run typecheck`, `npm test`, `verify:openapi`, `verify:asyncapi` en verde |
| R.1 permisos (`auth-service`) | Hecho (solo los del bloque A) | migración `20261021130000-add-treasury-permissions.js` aplicada **dos veces** sobre MySQL real sin duplicar; 259 pruebas de auth; `check-permissions.mjs` |
| R.2 módulo (`plugin-catalog-service`) | Hecho, **NO DESPLEGAR todavía** | migración `20261021150000-…` aplicada, repetida, deshecha y rehecha sobre MySQL real; 193 pruebas |
| R.3 gateway | Hecho | una regla por método y ruta, sin `/treasury/*` general; `treasury-routes.test.ts` 20 pruebas + mutación (reintroducir el catch-all hace fallar 5); 131 pruebas del gateway |
| R.4 bitácora | Hecho | dominio `treasury.`, 6 etiquetas es/en/fr, íconos/colores de `opened/loaded/credited/cancelled/posted/approved`; `check-audit-labels.mjs` (56 eventos); visto en la pantalla |
| R.5 contabilidad | **Solo etiquetas** (`receipt`, `receipt_void`) | las reglas de asiento del cobro son del bloque B |
| R.6 frontend base | Hecho | 4 pantallas + pestañas + navegación + ficha del cliente; 368 pruebas (28 nuevas), `lint:ui` (incluida la variante con archivos sin versionar), `vue-tsc`, `build` |
| A (modelo, partidas, condiciones, saldos iniciales, listados, antigüedad) | Hecho | **151 pruebas** en `treasury-service`; `scripts/verify-treasury.mjs` contra MySQL y RabbitMQ reales (30 facturas simultáneas + 30 reenvíos = 30 partidas); `scripts/local-stack/ronda4-tesoreria.mjs` por el gateway real; `scripts/local-stack/ui-tesoreria.cjs` por la interfaz con Administrador, Contador y Vendedor, es/en/fr y 390 px |
| A.4 prueba de oro (submayor = mayor) | **NO ejecutada** | necesita el asiento de apertura en contabilidad (los saldos iniciales no lo generan) |
| B cobros (recibos, anticipos, asiento, interfaz) | Hecho y **subido** (2026-10-21) | **235 pruebas** en `treasury-service` y 208 en `accounting-service`; `scripts/verify-receipts.mjs` contra MySQL, RabbitMQ y contabilidad reales (30 cobros simultáneos: exactamente 15 aceptados, sin interbloqueos ni números repetidos; **prueba de oro**: neto por cliente de tesorería = «cuentas por cobrar» del mayor, anticipos de cobros = «anticipos de clientes»); `scripts/local-stack/ui-cobros.cjs` por la interfaz con Administrador, Contador y Vendedor, es/en/fr y 390 px; frontend 393 pruebas, `lint:ui`, `vue-tsc`, `build` |
| C exportar, imprimir y recordatorios | Hecho en local, **sin commit ni push** (2026-10-22) | **279 pruebas** en `treasury-service` (31 de recordatorios, 13 de exportación), 30 en `notification-service`, 146 del gateway, 398 del frontend; `scripts/verify-reminders.mjs` contra MySQL, RabbitMQ y los servicios reales por el gateway (8 corridas simultáneas → UN evento y UN correo por cliente); `scripts/local-stack/ui-recordatorios.cjs` por la interfaz con tres roles, es/en/fr y 390 px |
| D cuentas por pagar y pagos | Hecho en local, **sin commit ni push** (2026-10-22) | **380 pruebas** en `treasury-service` (37 de deudas, 32 de pagos, 32 de HTTP), 230 en `accounting-service` (22 del asiento de pago), 259 en auth, 163 en el gateway, 415 en el frontend; `scripts/verify-payments.mjs` contra MySQL, RabbitMQ y compras reales (30 pagos simultáneos a una deuda → exactamente 10 aceptados, sin interbloqueos ni números repetidos; aprobación entre dos personas; **prueba de oro por proveedor**); `scripts/local-stack/ui-pagos.cjs` por la interfaz con Administrador, Contador (aprobación entre dos personas) y Vendedor, es/en/fr realmente aplicados y 390 px. Hoja de trabajo: `IMPLEMENTATION-D.md` |
| E | Sin empezar | — |

**Defectos que la revisión encontró (y por qué ninguna prueba los veía):**

1. `npm test` salía con error porque el servicio **no tenía ninguna prueba** → el CI de despliegue habría fallado.
2. **La migración del catálogo fallaba contra una base real** (`Unknown column 'service'`: la tabla `plugins` no tiene esa columna; es dato de la semilla). En producción habría roto el arranque de `plugin-catalog-service`. Solo se vio al aplicarla sobre MySQL.
3. `ANY /treasury/*` sin permiso y `ANY /treasury/receivables/*` en el gateway: cualquier ruta futura habría quedado abierta con solo el plugin.
4. «Vencidas» listaba partidas **pagadas o anuladas** con vencimiento pasado, y las partidas «fantasma» (anulación llegada antes que la emisión) salían en el listado.
5. Un cuerpo que no es JSON respondía **500** («error no controlado»): el validador de Hono lanza `HTTPException` y el manejador de errores no la conocía.
6. Reenviar la misma nota de crédito con otro `eventId` lanzaba un error en vez de ser un duplicado limpio; y `balanceOf` devolvía `-0` en una partida anulada sin aplicaciones.

Además se añadió la **validación de clientes en saldos iniciales** (`customer-service` por HTTP, 404 → 422 con el índice de la línea, caído → 502).

**Defectos que encontró la verificación del bloque B** (tampoco los veía ninguna prueba unitaria):

7. El **Contador no podía elegir cliente** al cobrar: no tiene `customer:read`, así que el selector salía vacío. Ahora ofrece a los clientes con deuda (de la antigüedad) cuando no puede leer el catálogo.
8. Partidas sembradas con ids de cliente inventados no se pueden cobrar (tesorería valida el cliente contra `customer-service` → 422): es lo correcto, pero las pruebas de interfaz deben elegir un cliente que exista.
9. Un id de anticipo consumido colisionaba al repetirse en la misma ventana; ahora se genera con `randomUUID`.
10. `buildDraft` dejaba que los valores por defecto pisaran los de la persona (orden del spread).

**Decisiones del bloque C (y por qué):**

- **Un correo por CLIENTE, no por partida.** El §8 pedía el evento `treasury.receivable.overdue` por partida; 31 facturas vencidas serían 31 correos (acoso, no cobranza). El evento es por cliente con hasta 20 partidas detalladas y el total de todas; la idempotencia sigue siendo por (partida, día) (`UNIQUE (receivable_id, reminder_date)`), y «una vez por semana» se decide leyendo la última fecha avisada. Una moneda distinta es un aviso aparte.
- **Apagado por defecto y solo el Administrador lo enciende** (`reminder:manage`). Un recordatorio es un correo al CLIENTE de la organización: `enabled` nace en `false`, encenderlo pide confirmación explícita en pantalla, cada cambio deja `treasury.reminder_settings.updated` con valor anterior y nuevo, y «enviar ahora» también se niega (409 `REMINDERS_DISABLED`) con los recordatorios apagados.
- **Exportar es un permiso aparte** (`receivable:export`, Administrador y Contador) y el CSV se arma **en el servidor**: así no hay forma de sacar la cartera sin que quede `treasury.report.exported` (reporte, filtros aplicados, filas, quién). Neutraliza fórmulas (`= + - @`), lleva BOM y se sirve con `Cache-Control: no-store`.
- **El proceso diario** corre dentro de `treasury-service` (cada `REMINDER_CHECK_MINUTES`, 15 por defecto; 0 lo apaga) desde las 09:00 locales, una vez al día por organización (`last_run_on`). Varias réplicas no se estorban: lo decide el UNIQUE, no un candado. Si customer-service u organization-service no responden la corrida se detiene SIN marcar el día y se reintenta en la próxima vuelta.
- **El cliente sin correo no se marca como avisado**: cuando se lo agreguen, el siguiente proceso lo avisa.
- **Notificaciones solo manda lo que el evento trae** (no consulta a nadie): por eso el evento lleva el correo del cliente y el nombre de quien cobra (`organization-service`). No hay proveedor de preferencias: es un correo al cliente, no a un usuario, igual que las reservas del restaurante.

**Defectos que encontró la verificación del bloque D** (ninguna prueba unitaria los veía):

11. **El Contador veía «Pagar» sobre un pago que exigía aprobación.** No puede leer el umbral (es del Administrador), así que la pantalla no sabía que faltaba la aprobación y el servidor respondía 409. Ahora cada pago trae `requiresApproval`.
12. Una factura de compra con vencimiento anterior a su emisión (dato absurdo) se corrige al día de emisión: una «vencida» en las pruebas hay que emitirla en el pasado, no solo vencerla.
13. La verificación en vivo de saldos iniciales buscaba su dato en una página de 100 filas y la base local ya acumulaba 222 vencidas: acota SIEMPRE por el cliente de la prueba.

**Aprendido al construir el bloque D:**

- Tesorería debe aplicar a las facturas de compra los MISMOS filtros que contabilidad (liquidación 03, moneda base, fecha de arranque, automática encendida, subtotal + impuestos = total) o las cuentas por pagar y el libro mayor divergen. Una factura anterior a `auto_posting_from` no abre deuda: para deudas «de hace 20 días» en pruebas se usan saldos iniciales.
- La unidad de trabajo en memoria de las pruebas **no** sirve para concurrencia (el rollback restaura una copia): los 30 pagos simultáneos van contra MySQL real.
- El orden de bloqueos (pago → deudas por id → anticipos por id → serie) es el que evita los interbloqueos; se repite en anular.
- El tercero (`partyType: supplier`) en las líneas de proveedores y de anticipos del asiento de pago es lo que permite cuadrar por proveedor.

**Aprendido al verificar el bloque C:**

- **Orden de despliegue: `notification-service` ANTES que `treasury-service`.** `notification-service` solo se enlaza a los eventos que su `template-config.json` conoce: si tesorería publica `treasury.receivable.overdue` antes de que notificaciones tenga la plantilla, el mensaje no llega a ninguna cola y la partida queda marcada como avisada sin que haya salido el correo. Con los recordatorios apagados por defecto el riesgo es bajo, pero respeta el orden.
- Una factura anterior a `auto_posting_from` de contabilidad **no abre partida** (tesorería imita sus filtros): para probar deudas «de hace 20 días» se usan saldos iniciales, que admiten cualquier fecha.
- El gateway limita las peticiones por minuto: una prueba de interfaz que va más rápido deja la página **en blanco** y las comprobaciones del tipo «no hay claves sin traducir» pasan en vacío. Exige siempre el encabezado de la pantalla antes de dar nada por bueno.
- `Response.text()` y los clientes HTTP descartan el BOM al decodificar: para probar que el CSV lo lleva hay que leer los bytes.
- La unidad de trabajo en memoria de las pruebas restaura una copia al hacer `rollback`: con dos corridas **concurrentes** esa copia pisa el commit de la otra. La concurrencia real se prueba contra MySQL (`verify-reminders.mjs`), no con repos en memoria.

**Aprendido al verificar (vale para las siguientes fases):**

- El router real del gateway es **Hono** (`app.all(rule.path, …)`, la primera regla que coincide gana, `*` en medio sí funciona). `matchRoute` de `src/core/router.ts` es código heredado que **no se usa**: no pruebes reglas con él.
- Desactivar un módulo es **programado** (`deactivate_at`, a fin de periodo): no se puede apagar para repetir una prueba.
- El filtro de bitácora por dominio viaja como `?event=treasury.` (prefijo con punto al final).
- `formatMoney` en español no agrupa miles en 4 cifras (`2000,00`): las pruebas de interfaz deben aceptar ambas formas.
- El login tiene límite de intentos: reutiliza una sesión por prueba en vez de iniciar sesión cien veces. Encadenar varias pruebas de interfaz seguidas (cada una abre 3 sesiones) lo agota y produce fallos que parecen de la pantalla: espera un par de minutos entre corridas.
- Dos tablas de bases distintas se cruzan con `COLLATE utf8mb4_unicode_ci` en ambos lados (el servidor MySQL local usa `utf8mb4_0900_ai_ci` por defecto).

**Orden de despliegue del bloque D** (sobre lo ya subido): `auth-service` (migración `20261023100000-add-treasury-payable-permissions`: `payable:read|export`, `payment:read|create|approve|void`) → `accounting-service` (el asiento del pago y su reversa: sin esto, los pagos quedan sin asiento y el submayor deja de cuadrar) → `treasury-service` (migración `20261023100000-create-payables` por su initContainer; variable nueva `PURCHASING_SERVICE_URL`, ya en su `k8s/deployment.yaml`; **la cola `treasury-service.events` se enlaza sola a `purchasing.bill.*` y `fiscal.ec.withholding.issued` al arrancar**) → `api-gateway-node` → `frontend`. Compras y el catálogo de plugins no cambian. Las facturas de compra que ya estaban contabilizadas **no se recuperan solas** (no hay replay): hay que cargarlas como deudas iniciales. Con el umbral de aprobación en NULL (nace así), un despliegue no cambia el comportamiento de nada existente.

**Orden de despliegue del bloque C** (sobre lo ya subido): `auth-service` (migración `20261022100000`: `receivable:export` y `reminder:manage`) → **`notification-service`** (la plantilla `treasury.receivable.overdue`) → `treasury-service` (migración `20261022100000-create-reminders` por su initContainer; variable nueva `ORGANIZATION_SERVICE_URL`, ya en su `k8s/deployment.yaml`) → `api-gateway-node` (rutas de exportar y de recordatorios) → `frontend`. Después, para que le lleguen correos a un cliente de verdad, hace falta el SMTP real en `notification-service` (hoy es Mailtrap) y que los clientes tengan correo.

**Orden de despliegue del bloque B:** `auth-service` (permisos `receipt:*`, migración `20261021170000`) → `treasury-service` (necesita el bloque 0.1 del dueño: repo, `treasury_db` y su usuario, secretos) → `accounting-service` (regla del asiento del cobro y su reversa) → `api-gateway-node` → `frontend`. La migración de `plugin-catalog-service` (que vuelve «disponible» el módulo) va **al final**, cuando lo anterior esté arriba: B y su interfaz ya existen, pero falta todavía el asiento de apertura en producción para la prueba de oro.

---

## 1. Reglas que no se negocian (y por qué)

Cada una cuesta un bug real de la Fase 2. Están todas verificadas contra el código de hoy.

1. **Sin commit ni push** salvo que el dueño lo pida; sin `Co-Authored-By` ni línea de atribución a Claude. Un push a `main` de un repo de
   servicio **despliega a producción**.
2. **Trabajas en paralelo con otro agente en el mismo árbol.** Antes de crear un archivo, lista el directorio; antes de editar uno ya
   modificado, léelo. Hay cambios ajenos **sin commitear** en `frontend/` (reservas de restaurante, `scripts/check-audit-labels.mjs`,
   `router/index.ts`, `AppTopBar.vue`…) y en `plugin-catalog-service/seed/*.json`: **no los reviertas ni los mezcles** en tus commits.
3. **Dinero en centavos enteros** (`bigint` en cálculos, redondeo UNA vez por línea, mitad hacia arriba); cantidades y saldos como
   **texto** en la API. Reúsa `purchasing-service/src/domain/money.ts`, no lo reinventes.
4. **Fechas sin hora (`issueDate`, vencimientos) NO pasan por conversión UTC.** En la Fase 2 una fecha `2026-10-20` se asentó como
   `2026-10-19` (huso de Ecuador) y **no se asentó nada** hasta que se corrigió (`localDateOf` en `accounting-service/src/domain/posting.ts`
   devuelve las cadenas `YYYY-MM-DD` tal cual). Guarda fechas de calendario como `DATE`/texto `YYYY-MM-DD` y pruébalo con una fecha de
   «hoy» generada en el huso del servidor y otra a las 23:30 hora local.
5. **Concurrencia: `READ COMMITTED` para sumar, no `FOR SHARE`.** Calcular el saldo de una partida bajo `FOR SHARE` produjo
   interbloqueos (27 de 30 operaciones simultáneas devolvieron 409). El patrón correcto está en `PostBillUseCase` de compras
   (`begin({ readCommitted: true })` en `repositories.ts`): bloquea la **fila de la partida** con `FOR UPDATE` y suma las aplicaciones
   dentro de esa transacción. Prueba con **30 cobros simultáneos** contra MySQL real.
6. **Cada escritura publica un evento por outbox en la MISMA transacción**, **incluida la rama de excepción/«override»**. En la Fase 2
   la excepción de una factura no publicaba `bill.posted` y contabilidad nunca asentó (§12.8). Si hay dos caminos para llegar al mismo
   estado, los dos emiten el mismo evento de negocio.
7. **Un controlador que recibe un campo y no lo pasa al caso de uso es un bug invisible** (`product-service` descartaba `trackStock` y
   ninguna prueba unitaria lo vio). Por eso cada campo de entrada tiene una prueba **HTTP** que lo envía y lo lee de vuelta, y la
   prueba final pasa **por el gateway real**, no por el servicio.
8. **Los listados devuelven lo que dice el contrato.** `lineCount` salía 0 en recepciones y facturas porque el listado no cargaba las
   líneas. Si el `openapi.yaml` declara un campo en el listado, hay una prueba contra MySQL que lo comprueba (los repositorios en
   memoria no lo cazan).
9. **El destino de un dato lo decide el servidor, no el cliente** (la línea de compra «inventario o gasto» la decide el catálogo). En
   tesorería: el cliente de un recibo, el saldo de una partida y el vencimiento los calcula el servidor; lo que mande el cliente se
   **compara**, no se acepta.
10. **Nunca supongas «gasto»/«cero» cuando un catálogo no responde:** catálogo caído → 502 `CATALOG_UNAVAILABLE`; no existe → 422.
11. **Los permisos concedidos son permisos exigidos.** Cada permiso nuevo tiene una ruta que lo pide y una prueba que devuelve 403 sin él
    (en la Fase 2 `purchase_bill:create_unmatched` se concedió y ninguna ruta lo exigía).
12. **Conceder permisos por nombre de rol, a TODOS los roles con ese nombre** (plantilla global + roles ya clonados por cada organización)
    y **a los roles de lectura y de contador, no solo a Administrador/Supervisor.** El Contador no podía abrir contabilidad porque la
    migración original no lo contemplaba (`20261021120000-grant-accounting-and-purchasing-to-accountant-and-readonly.js`). Súbelo con un
    bump de `permissions_version`.
13. **Íconos:** todo `mdi-*` que escribas debe existir en `@mdi/font`; `npm run lint:ui` ahora lo comprueba (`scripts/check-icons.mjs`).
    Una pestaña o botón de la misma fila no se queda sin icono.
14. **Claves de i18n completas en es/en/fr**, incluidas las de **origen de asiento** (`accounting.entry.sourceTypes.*`) y las de
    **pendientes** (`accounting.auto.pending.sources.*`): se olvidaron en compras y la pantalla mostró la clave técnica.
15. **Secretos:** nunca en archivos del repo ni en docs; `config/secrets.production.enc` con SOPS y finales de línea **LF** (un CRLF rompió
    `DB_HOST`/`DB_USER` en accounting). No crees cuentas ni cambies contraseñas de nadie.
16. **No edites una migración ya aplicada:** crea otra con timestamp posterior, idempotente cuando toque datos.
17. **Verifica antes de afirmar.** Un síntoma aquí suele tener otra causa (el 502 de `crm` era la IP del nodo, no Cloudflare).

---

## 2. Estado de partida (verifica antes de empezar)

| Pieza | Estado a 2026-10-21 | Dónde |
|---|---|---|
| Contabilidad (Fase 1) y asientos automáticos | **En producción** | `accounting-service`, roles `cash`, `bank`, `receivables`, `customer_advances`, `payables`, `supplier_advances` (`src/domain/account.ts:33`) |
| Compras (Fase 2) hasta factura contabilizada | **En producción**, probado de punta a punta con dos usuarios reales | `purchasing-service`; publica `purchasing.bill.posted`/`voided` |
| `billing.invoice.issued` ampliado | **Hecho** (`customerId`, `issueDate`, `posSaleId`, `relatedInvoiceId`, `documentTypeCode`, `customerSnapshot`, importes) | `billing-service/asyncapi.yaml` línea 24 |
| Retención en compra | Fiscal publica `fiscal.ec.withholding.issued` (RUC del proveedor + `support.number`, **sin id de factura**) | `fiscal-ecuador` |
| Cobros, pagos, vencimientos, estado de cuenta | **No existen** (ni tabla, ni días de crédito, ni cupo) | — |
| Módulo `finance.accounts_receivable_payable` | En el catálogo con `status: "falta"`, `service: null`, fase 3 | `plugin-catalog-service/seed/plugins-dependencias.json:241` |

**Verifica** (comandos de lectura): `grep -n "issued" backend/billing-service/asyncapi.yaml`; `grep -n "'receivables'" backend/accounting-service/src/domain/account.ts`;
`node scripts/check-permissions.mjs`.

### Límite heredado que esta fase debe resolver

La **retención en compra** se asienta hoy con «Dr proveedores» **sin el proveedor como tercero** (fiscal solo conoce su RUC). El saldo
global de proveedores es correcto, pero el **desglose por proveedor no baja** con la retención. El bloque D lo cierra: el submayor de
pagar identifica al proveedor por RUC + número del documento sustento (igual que `HandleWithholdingIssuedUseCase` de compras) y la
retención reduce **su** partida. Ver D.3.

---

## 3. Mapa de bloques y orden

| Bloque | Entrega | Quién hace qué |
|---|---|---|
| **0** | Repo, base de datos, secretos, CI, compose, esqueleto del servicio | dueño (repo/base/secretos) + agente (código) |
| **A** | Submayor de cuentas por cobrar, condiciones de crédito, saldos iniciales, lectura | agente |
| **B** | Cobros: recibos, aplicación, anticipos, asiento, UI | agente |
| **C** | Estado de cuenta, antigüedad de cartera, recordatorios | agente |
| **R** | Cableado transversal: **permisos, módulo en el catálogo, gateway, bitácora, frontend base** | agente (se hace con A, ver §5) |
| **D** | Fase 3.2: cuentas por pagar y pagos a proveedores | agente, después de B |
| **E** | Fase 3.3: bancos, extractos, conciliación, flujo de caja | agente, después de D |
| **F** | Despliegue y prueba funcional en producción | dueño sube; agente verifica |

**D y E no se empiezan hasta que A, B y C estén desplegados y probados en producción** (regla del plan: no se apila una fase sin
cerrar la anterior).

Orden de despliegue (el CI de cada repo despliega con push a su rama principal; **nunca todos a la vez**):
`auth-service` → `billing-service` (si cambió) → `plugin-catalog-service` (módulo en «disponible») → `treasury-service` →
`accounting-service` → `api-gateway-node` → `frontend`. Razón: los permisos y el módulo deben existir antes de que el servicio los exija;
el gateway se sube **después** del servicio para que no enrute a un destino que aún no responde; el frontend al final, porque sin
permisos desplegados las pantallas no se ven.

---

## 4. BLOQUE 0 — Preparación y esqueleto

### 0.1 Lo que solo puede hacer el dueño (déjalo escrito en `COSAS-POR-HACER.md`, con casillas)

- [ ] Crear el repo `facturero/treasury-service` (rama `main`) y los secretos `NODE_AUTH_TOKEN` y `SOPS_AGE_KEY` (como `purchasing-service`).
- [ ] En el MySQL del clúster: `CREATE DATABASE treasury_db`, `CREATE USER treasury_user`, `GRANT` solo a esa base (patrón de `purchasing_db`).
- [ ] Crear `config/secrets.production.enc` con SOPS (**finales de línea LF**) a partir de `config/secrets.production.example` (sin valores reales).
- [ ] Crear el Secret `treasury-db` del clúster con `host`, `port`, `user`, `password`, `name` (es lo que lee `k8s/deployment.yaml`).

### 0.2 Esqueleto (copia de `purchasing-service`; lista el directorio antes de crear nada)

- [ ] `package.json`, `tsconfig.json`, `vitest.config.ts`, `Dockerfile`, `.dockerignore`, `.gitignore`, `.npmrc`, `.sequelizerc`, `sequelize.config.cjs`,
      `.sops.yaml`, `.env.example`. Nombre del paquete `treasury-service`, puerto 3018.
- [ ] `src/main.ts`, `src/domain`, `src/application`, `src/infrastructure` (persistencia, mensajería con `@facturero/outbox-relay`,
      `telemetry/otel.ts` copiado de compras para que aparezca en SigNoz), `src/interface/http`.
- [ ] `GET /health` sin autenticación (la sonda de K8s). Middleware de contexto que lee `X-User-Id`, `X-Organization-Id`, `X-Permissions`
      **que inyecta el gateway** desde el token; el servicio **nunca** confía en otra fuente (el gateway ya ignora lo que mande el cliente).
- [ ] Outbox + consumidor con inbox/idempotencia (`InboxConsumer`, exchange `crm.events`, cola propia `treasury-service`).
- [ ] `k8s/deployment.yaml` (con `initContainer` `treasury-migrate` que corre `npx sequelize-cli db:migrate`, como compras) y `k8s/service.yaml`
      (`treasury-service-node:3018`).
- [ ] `.github/workflows/deploy.yml` (copia el de compras: typecheck, tests, `check-openapi-routes.mjs`, `check-asyncapi-events.mjs`, build, push,
      `envsubst | kubectl apply`). **Copia también los dos scripts de verificación** a `scripts/` y adáptalos.
- [ ] `openapi.yaml` y `asyncapi.yaml` iniciales (vacíos de rutas pero que **parseen**; los guardianes corren desde el primer commit).
- [ ] Observabilidad: spans HTTP hacia el collector del clúster (variables como en `purchasing-service/k8s/deployment.yaml`).
- [ ] Compose local (**`docker-compose.yml` de la raíz**): servicio `treasury-service` + `treasury-migrate`, variables, puerto 3018, `depends_on`
      de MySQL y RabbitMQ sanos. Y `docker/mysql/init.sql`: base `treasury_db` y usuario con `GRANT` solo a su base.
      En el stack local de esta máquina el MySQL de Docker sale por el **3307** (`scripts/local-stack/mysql-3307.override.yml`); levanta siempre con ese `-f`.
- [ ] Añade `treasury-service` a `scripts/local-stack/levantar-desde-main.sh` **solo cuando exista en remoto** (ese script clona `main`).
- [ ] **Criterio:** `npm run typecheck`, `npm test` y el CI verdes con un servicio que solo responde `/health`.

---

## 5. BLOQUE R — Cableado transversal (se hace junto con el bloque A; cada punto es una casilla)

> Una pieza sin estas casillas **no está terminada**. Son el «contrato» de la Fase 2 §1, con los ficheros exactos.

### R.1 Permisos (`auth-service`)

Migración **nueva** `backend/auth-service/migrations/<timestamp>-add-treasury-permissions.js`, mismo patrón que
`20261016140000-add-purchasing-permissions.js` (id determinista por `md5(code)`, `INSERT … ON DUPLICATE KEY UPDATE description`,
`INSERT IGNORE INTO role_permissions … FROM roles r WHERE r.name IN (:roleNames)` **sin filtro de organización**, y **un solo bump** de
`users.permissions_version` al final). Timestamp posterior a `20261021120000`.

Catálogo propuesto (nombre `<recurso>:<acción>`; **cada uno lo exige una ruta**, ver tabla de rutas en A.5/B.1):

| Permiso | Qué permite | Administrador | Supervisor | Contador | Solo lectura | Vendedor |
|---|---|:-:|:-:|:-:|:-:|:-:|
| `receivable:read` | Ver cartera, antigüedad y estado de cuenta | ✔ | ✔ | ✔ | ✔ | — |
| `receipt:read` | Ver recibos de cobro | ✔ | ✔ | ✔ | ✔ | — |
| `receipt:create` | Crear y **contabilizar** recibos de cobro | ✔ | ✔ | ✔ | — | — |
| `receipt:void` | **Anular** un recibo contabilizado (con motivo) | ✔ | — | — | — | — |
| `customer_terms:manage` | Cambiar días de crédito y cupo de un cliente | ✔ | — | ✔ | — | — |
| `opening_balance:load` | Cargar saldos iniciales de cartera (con fecha de corte) | ✔ | — | — | — | — |
| `payable:read` *(D)* | Ver deuda con proveedores | ✔ | ✔ | ✔ | ✔ | — |
| `payment:read` *(D)* | Ver pagos a proveedores | ✔ | ✔ | ✔ | ✔ | — |
| `payment:create` *(D)* | Crear y contabilizar pagos | ✔ | — | ✔ | — | — |
| `payment:void` *(D)* | Anular un pago contabilizado | ✔ | — | — | — | — |
| `bank_account:manage` *(E)* | Cuentas bancarias y extractos | ✔ | — | ✔ | — | — |
| `reconciliation:manage` *(E)* | Conciliar | ✔ | — | ✔ | — | — |

Notas:
- **Separación de funciones** (como en compras): quien cobra no anula; anular exige `receipt:void` (solo Administrador), **motivo
  obligatorio** (mínimo 5 caracteres) y queda en bitácora con actor y motivo.
- `receipt:create` cubre crear **y** contabilizar: **no inventes `receipt:post` ni `receipt:update`** (en compras `update`/`post` no existían en
  `auth-service` y editar con ellos habría dejado permisos de adorno). Si el dueño quiere separarlos, es una decisión nueva.
- Los permisos de D y E van en **su propia migración** cuando se construyan (no los concedas antes de que haya rutas que los exijan).
- Si algún rol de lectura debe ver cartera, **inclúyelo desde el primer día** (el Contador no podía entrar a contabilidad por omisión).
- [ ] La migración corre **dos veces sin duplicar** (idempotente) y su `down` retira solo lo que concedió.
- [ ] `node scripts/check-permissions.mjs --strict` en verde (ningún servicio exige un permiso inexistente y ninguno del catálogo queda sin uso).
- [ ] Prueba HTTP por cada permiso: sin él → 403; con él → 2xx. Y `X-Permissions: *` enviado por un cliente **no concede nada** (lo ignora el gateway).

### R.2 Módulo en el catálogo (`plugin-catalog-service`) — «postularlo» y activarlo

El módulo ya existe como **«falta»**. Para que se pueda **activar y comprar**:

1. **Semillas** (`backend/plugin-catalog-service/seed/`): en `plugins-dependencias.json` cambia `status` de `falta` a `hecho`, pon
   `service: "treasury-service"`, y `depends_on: ["finance.electronic_invoicing", "finance.general_ledger"]`; ajusta `description` si cambió el
   alcance. `plugins-i18n.json` (en/fr) y `plugins-precios.json` (**799 = provisional**, el dueño decide) ya están: confirma que describen
   cobros y pagos tal como quedan. `perfiles-negocio.json`: hoy aparece como `suggested` en un perfil; decide con el dueño en cuáles más
   se recomienda (comercio, servicios con crédito) y deja las tres lenguas en `plugins-i18n.json`.
2. **Migración idempotente** `backend/plugin-catalog-service/migrations/<timestamp>-enable-accounts-receivable-payable.cjs`, patrón de
   `20261016130000-enable-purchasing-plugins.cjs`: **la semilla original ya está en `SequelizeMeta` y no vuelve a correr en producción**, añadir
   filas al JSON no basta. Debe: poner `build_status = 'disponible'` y la descripción, **añadir la arista** `finance.general_ledger`
   (`INSERT IGNORE INTO plugin_dependencies … auto_activate = 1`, omitiendo módulos `is_core`) y actualizar las traducciones en/fr. Debe dejar **igual**
   una base migrada y una recién sembrada.
3. **Postularlo = hacerlo visible y comprable:** al pasar a `disponible` entra en el catálogo de módulos de la organización
   (`GET /plugins` → pestaña «Catálogo»), con su precio, y se puede **añadir al carrito y activar** (el cobro real aún no existe:
   los módulos se activan sin pagar hoy). El resto de organizaciones **no** lo tienen activo; cada una lo activa.
4. **La activación** emite `plugin.activated` (ya existe). `accounting-service` ya escucha `plugin.activated`/`plugin.deactivated` para su
   conmutador de contabilización automática; **comprueba si tesorería necesita lo mismo** (que al desactivar el módulo se deje de
   consumir y se conserven los datos) y deja la decisión escrita.
- [ ] Migración corrida **dos veces** contra MySQL sin duplicar aristas ni traducciones (verificación escrita en el PR).
- [ ] La suite de `plugin-catalog-service` en verde (incluido `pricing.test.ts`, que menciona este módulo).
- [ ] En un stack limpio: el módulo aparece como disponible, se activa por la API y por la UI, y arrastra `finance.general_ledger` si faltaba.

### R.3 API Gateway (`api-gateway-node`)

- [ ] `src/config/env.ts`: `TREASURY_SERVICE_URL: z.string().url().optional()` (junto a `PURCHASING_SERVICE_URL`, línea 30).
- [ ] `src/config/gateway.config.ts`: `if (env.TREASURY_SERVICE_URL) services.push({ name: 'treasury-service', url: env.TREASURY_SERVICE_URL })`
      (junto a la línea 51).
- [ ] `k8s/deployment.yaml`: `TREASURY_SERVICE_URL` = `http://treasury-service-node:3018` (junto a `PURCHASING_SERVICE_URL`, línea ~55).
- [ ] **Rutas** `/treasury/*` en `gateway.config.ts`, **cada una con `requiresPlugin: 'finance.accounts_receivable_payable'`, su
      `permission` y `stripPrefix: ''`** (el servicio sirve el prefijo `/treasury`). Primera coincidencia gana: **las específicas antes que las
      generales** (`/treasury/receipts/*/void` antes de `/treasury/receipts/*`). Imita las de `/purchasing/bills/*`. `maxBodyBytes: 256 * 1024` donde haya cuerpo grande.
- [ ] `src/config/treasury-routes.test.ts` (copia `purchasing-routes.test.ts`): cada ruta resuelve al servicio, exige el plugin y el permiso
      correctos, respeta el tope de cuerpo y la general no se come a la específica.
- [ ] Verificación **por el gateway real** del stack (`localhost:8080`): sin token 401 · con token pero **sin el plugin 403** · con token y plugin pero **sin
      permiso 403** · con todo 200. Y `X-Organization-Id` / `X-Permissions` falsos enviados por el cliente **no filtran datos de otra organización**
      (copia `scripts/local-stack/ronda3-seguridad.mjs`).

### R.4 Bitácora (`audit-log-service` + pantalla)

La bitácora se enlaza con `#` a `crm.events` y **audita todo evento** (su denylist está vacía): la cobertura depende de que **cada escritura
publique un evento en la misma transacción** (regla 6 de §1). **No hace falta tocar `audit-log-service`** salvo que falte algo real. Lo que **sí**
hay que tocar es cómo se **ve**:

- [ ] **Dominio nuevo en el filtro:** `frontend/src/views/audit/AuditLogView.vue` (lista `domains`, junto a `purchasing.`): añade
      `{ title: t('audit.domain.treasury'), value: 'treasury.' }` y la clave `audit.domain.treasury` en `es/en/fr.json`.
- [ ] **Etiqueta de cada evento publicado**, en es, en y fr, con la clave `audit.event.<routing_key con puntos → guiones bajos>`
      (p. ej. `audit.event.treasury_receipt_posted`). Frases en pasado para una persona no técnica: «Cobro registrado», «Cobro anulado»,
      «Saldos iniciales de cartera cargados», «Condiciones de crédito del cliente cambiadas».
- [ ] **Íconos y colores:** `iconFor`/`colorFor` clasifican por subcadena de la acción (`created`, `voided`, `posted`, `approved`…). Usa
      acciones que ya caigan bien; si una nueva no cae, añádela allí (mismo cambio).
- [ ] **Lo importante se guarda en el payload** (la bitácora muestra el payload redactado, tope **8 KB**, y **redacta** claves como `token`,
      `secret`, `password`, `authorization`, `certificate`): el payload de cada evento lleva **qué cambió, no solo el id**. Mínimo exigido:

  | Evento | Debe llevar en el payload (además de `organizationId` y el actor que añade el relay) |
  |---|---|
  | `treasury.receipt.created` / `posted` | `receiptId`, `number`, `customerId`, nombre del cliente, fecha, medio de cobro, cuenta de caja/banco, **total**, **aplicado**, **excedente a anticipo**, `lineCount` y las partidas aplicadas (`receivableId`, `invoiceNumber`, `appliedCents`) hasta 20 |
  | `treasury.receipt.voided` | `receiptId`, `number`, `reason` (**el motivo**), quién lo había contabilizado, total |
  | `treasury.receivable.opened` / `cancelled` | `receivableId`, `sourceType`/`sourceId`, `invoiceNumber`, `customerId`, importe, `dueDate` |
  | `treasury.receivable.written_off` | `receivableId`, saldo castigado, `reason` |
  | `treasury.opening_balance.loaded` | `cutoffDate`, nº de clientes, **total cargado**, quién lo cargó, `reason` |
  | `treasury.customer_terms.updated` | `customerId`, **valor anterior y valor nuevo** de días de crédito y cupo |
  | `treasury.payment.*` *(D)* | análogo al recibo, con proveedor, medio, cuenta y facturas pagadas |
  | `treasury.bank_reconciliation.*` *(E)* | cuenta, periodo, diferencia final, quién concilió |

- [ ] **Guardián de etiquetas:** `frontend/scripts/check-audit-labels.mjs` (hoy **sin versionar**, no corre en CI) recorre
      `backend/*/asyncapi.yaml` y exige `audit.event.*` en las tres lenguas. Córrelo en local y déjalo en verde; **no lo subas tú**: es del otro lote.
- [ ] **Guardián de cobertura de escrituras:** `src/__tests__/audit-coverage.test.ts` (copia el de compras) recorre las rutas de escritura y
      falla si un caso de uso no publica evento. Añade cada caso de uso a ese guardián.
- [ ] **Por evento una prueba:** el caso de uso deja **exactamente un** registro de outbox con el routing key, `organizationId` y los campos del
      asyncapi. Y una verificación de punta a punta: haz la acción por la UI y comprueba que aparece en `/audit-logs` con su etiqueta, su actor y el
      detalle legible (`scripts/local-stack/barrido-pantallas.cjs` ya recorre la pantalla de bitácora en es/en/fr).
- [ ] **Lo que se audita además de las escrituras de negocio:** el **inicio de sesión** ya lo registra `auth`; las **lecturas no** emiten (listar, ver
      estado de cuenta). Sí emite: **exportar** la cartera o el estado de cuenta a CSV (dato sensible que sale del sistema): `treasury.report.exported` con
      qué reporte, filtros y nº de filas.

### R.5 Contabilidad (`accounting-service`) — los asientos los escribe contabilidad, no tesorería

- [ ] **Consumir** los eventos de tesorería: añade a `POSTING_EVENT_TYPES` (de donde sale `CONSUMED_BINDINGS`, `consumer.ts:11`) `treasury.receipt.posted`
      y `treasury.receipt.voided`, y a su `asyncapi.yaml` los canales con quién los publica y qué hace el consumidor ante duplicado y desorden.
- [ ] **Reglas** en `src/domain/posting.ts` (junto a `draftFromWithholdingIssued`, línea 274): `draftFromReceiptPosted` y su reversa.
      **Dr** `cash`/`bank` por el total → **Cr** `receivables` por lo aplicado, **con el cliente como tercero** (`party`), y **Cr** `customer_advances` por el excedente.
      La factura **no** se asienta otra vez (la asentó `billing.invoice.issued`). **Fecha del asiento = la fecha del recibo sin conversión UTC** (regla 4).
- [ ] **Moneda:** lo que no esté en la moneda base queda **bloqueado con `CURRENCY_MISMATCH`** (copia el criterio de compras), nunca asentado mal.
- [ ] **Si falta un rol/cuenta** (`cash`, `bank`, `receivables`, `customer_advances`) el asiento queda en **«Pendientes»** y se reintenta; **no se inventa una cuenta**.
- [ ] **Idempotente por `source_type`/`source_id`**, con `source_type: 'receipt'` y `'receipt_void'`.
- [ ] **Etiquetas de origen en el frontend** (olvidadas en compras): `accounting.entry.sourceTypes.receipt` y `…receipt_void`, y
      `accounting.auto.pending.sources.receipt|receipt_void` en `es/en/fr.json`. Hay prueba que comprueba el respaldo, pero la etiqueta tiene que existir.
- [ ] Pruebas (`__tests__/`, estilo `purchase-posting.test.ts`): asiento cuadrado, reversa, excedente a anticipo, sin cuenta → pendiente, moneda ≠ base → bloqueado,
      fecha de «hoy» y a las 23:30, duplicado ignorado.

### R.6 Frontend base (el resto de pantallas va en cada bloque)

- [ ] `frontend/src/menus/navigation.ts`: entrada `nav.treasury` con `permission: 'receivable:read'`, `plugin: 'finance.accounts_receivable_payable'`, icono **validado**
      contra `@mdi/font` (`mdi-cash-multiple` existe), a `/treasury/receivables`, `activeFor: ['/treasury']`.
- [ ] `frontend/src/router/index.ts`: rutas `/treasury/receivables`, `/treasury/receipts`, `/treasury/receipts/:id` con `meta` de permiso y plugin (copia las de compras).
      **Ojo:** ese archivo tiene cambios ajenos sin commitear (reservas): edita solo tus líneas y, al preparar el commit, sepáralas (`git add -p` no funciona
      sin interacción: usa el truco de `git update-index --cacheinfo` con un blob derivado de `HEAD`, como se hizo con `package.json`).
- [ ] `frontend/src/types/treasury.ts`, `src/api/treasury.ts`, `src/stores/treasury.ts`, `src/utils/treasury.ts` **con pruebas** (acciones por permiso: `receiptActions(receipt, can)`).
- [ ] i18n `nav.treasury`, `treasury.*`, `audit.domain.treasury` y `audit.event.treasury_*` en **es/en/fr completos**; sin textos duros en español dentro de las vistas.
- [ ] Todo botón y todo menú **se oculta** si la persona no tiene el permiso (y el servidor lo vuelve a comprobar).
- [ ] `docs/UI-UX.md` si tocas un default o una decisión central. `npm run lint:ui` (ahora incluye `check-icons`), `npm run typecheck`, `npm test` y `npm run build` en verde.

---

## 6. BLOQUE A — Submayor de cuentas por cobrar

Cada paso termina con «**Cumple §1 y R**».

### A.1 Modelo de datos (migraciones de `treasury-service`; ninguna se edita después de aplicada)

Tablas (todas con `organization_id` y `UNIQUE`/índices que lo incluyan; **toda consulta filtra por organización**, probado por HTTP y contra MySQL):

- `receivables` (partidas abiertas): `id`, `organization_id`, `customer_id`, `customer_name`, `customer_identification` (copia del evento), `source_type` (`invoice` |
  `credit_note` | `initial_balance`), `source_id`, `document_number`, `issue_date DATE`, `due_date DATE`, `currency_code`, `original_cents`, `status`
  (`open|partial|paid|written_off|cancelled`), `version`, `created_at`, `updated_at`. **`UNIQUE (organization_id, source_type, source_id)`** = idempotencia.
  **El saldo NO es una columna que se resta a mano**: se **deriva** de sumar `receipt_applications` y `credit_applications` (así reintentar un evento no descuadra).
- `customer_terms`: `organization_id`, `customer_id`, `credit_days` (0–365), `credit_limit_cents NULL`, `updated_by`, `updated_at`. `PK (organization_id, customer_id)`.
- `receipts`: `id`, `organization_id`, `number` (`RC-AAAA-NNNNNN`, asignado **al contabilizar**, no al crear: los borradores no gastan secuencial; **comprueba en
  `purchasing-service` cuándo se asigna el número — la doc y el código no coinciden — y quédate con lo que hace el código, escribiendo el porqué**), `customer_id`,
  `customer_name`, `receipt_date DATE`, `method` (`cash|transfer|check|card|other`), `reference NULL` (**obligatoria** en `check` y `transfer`), `account_id`,
  `account_code`, `account_name` (copia de la cuenta `cash`/`bank` elegida: el recibo sigue legible si luego se renombra), `total_cents`, `applied_cents`,
  `advance_cents`, `status` (`draft|posted|voided`), `void_reason`, `voided_by`, `posted_by`, `version`, `created_at`.
  **`CHECK (total_cents = applied_cents + advance_cents)`**, importes ≥ 0.
- `receipt_applications`: `receipt_id`, `receivable_id`, `applied_cents > 0`; **`UNIQUE (receipt_id, receivable_id)`** (no se aplica dos veces la misma partida).
- `customer_advances`: saldo a favor por cliente con origen (`receipt_id` o `credit_note`) y aplicaciones; igual criterio: saldo derivado.
- `opening_balance_loads`: `id`, `organization_id`, `cutoff_date`, `loaded_by`, `reason`, `total_cents`, `created_at` (una carga por (organización, fecha de corte); no se repite).
- `sequences` (contador por organización y año), `outbox_messages`, `processed_events` (inbox) y los índices de listado (`customer_id`, `status`, `due_date`).
- [ ] Migración **idempotente**, `CHECK` y `UNIQUE` probados contra MySQL real (importes incoherentes rechazados por el esquema, no solo por el código).

### A.2 Dominio y casos de uso (con repos en memoria **y** pruebas contra MySQL)

- [ ] **Alta de partida desde `billing.invoice.issued`** (§3.1 del diseño): una venta del **POS** (`posSaleId != null`) **no** abre partida (ya se cobró). Las demás
      facturas sí, con `due_date = issueDate + días de crédito vigentes en ese momento`; cambiar los días **no** reescribe partidas ya creadas (si no, la
      antigüedad mentiría hacia atrás). `issueDate` es una **fecha sin hora**.
- [ ] **Nota de crédito** (`documentTypeCode` de nota de crédito): con `relatedInvoiceId` conocido, **abona a esa partida**; si no se conoce o llegó antes que su
      factura, queda como **saldo a favor** y se aplica al llegar (tolerante a desorden, idempotente).
- [ ] **`billing.invoice.voided`** cierra la partida (`cancelled`) y **no** se puede cerrar una con cobros aplicados sin anular antes el recibo (error claro).
- [ ] **Estados derivados:** `open` (sin aplicaciones), `partial`, `paid` (saldo 0), `written_off`, `cancelled`.
- [ ] **Condiciones por cliente:** `PUT /treasury/customers/:id/terms` (`customer_terms:manage`), con valor anterior y nuevo en el evento (R.4).
- [ ] **Saldos iniciales:** `POST /treasury/opening-balances` (`opening_balance:load`): lote de `{customerId, documentNumber, issueDate, dueDate, amountCents}` con
      **fecha de corte** y **motivo** obligatorios; crea partidas `initial_balance`; **una sola carga por fecha de corte**; todo o nada (una transacción); evento con el total.
- [ ] **Listados:** `GET /treasury/receivables` (filtros: cliente, estado, vencidas, rango de fechas; paginado) y
      `GET /treasury/customers/:id/statement` (partidas + cobros aplicados, saldo corriente y saldo a favor). **`lineCount`-style: lo que el contrato declara se
      devuelve** (regla 8): comprueba contra MySQL.
- [ ] **Antigüedad de cartera** `GET /treasury/receivables/aging` (corrientes, 1–30, 31–60, 61–90, +90 días vencidos; por cliente y total).

### A.3 Contrato

- [ ] `openapi.yaml`: cada ruta con método, parámetros, cuerpo, **todas** las respuestas (200/201, 400/422 con el formato de error del servicio, 401, 403, 404, 409,
      502), el permiso (`x-permission`) y el plugin (`x-plugin`). Referencia de nivel de detalle: `purchasing-service/openapi.yaml`.
- [ ] `asyncapi.yaml`: cada evento **publicado** (canal = routing key exacta, **tres segmentos** `treasury.<recurso>.<acción>`, acción en pasado) con su payload completo, y cada
      **consumido** (`billing.invoice.issued`, `billing.invoice.voided`, `plugin.activated|deactivated` si aplica) con quién lo publica y qué hace ante duplicado/desorden.
- [ ] Los guardianes `check-openapi-routes.mjs` y `check-asyncapi-events.mjs` (copiados en 0.2) **en verde** y enganchados al CI.

### A.4 Prueba de oro del bloque A

Con la cartera de un cliente de prueba (2 facturas + 1 nota de crédito + 1 anulación), **la suma de saldos del submayor de tesorería cuadra al centavo con el saldo
de `receivables` de esa organización en contabilidad** (`GET /accounting/reports/ledger`, por tercero). Se corre en local con el stack completo y, después, en producción sobre
el cliente de prueba. Si no cuadra, **el bloque no está terminado**.

---

## 7. BLOQUE B — Cobros

- [x] **B.1 Recibos** `draft → posted → voided`, numeración al contabilizar, permisos de R.1. Rutas (todas con plugin y permiso en el gateway):

  | Ruta (`/treasury/…`) | Permiso |
  |---|---|
  | `GET receipts`, `GET receipts/:id` | `receipt:read` |
  | `POST receipts` (borrador), `PUT receipts/:id` (solo borrador), `POST receipts/:id/post` | `receipt:create` |
  | `POST receipts/:id/void` (motivo ≥ 5 caracteres) | `receipt:void` |
  | `GET receivables`, `GET receivables/aging`, `GET customers/:id/statement` | `receivable:read` |
  | `PUT customers/:id/terms` | `customer_terms:manage` |
  | `POST opening-balances` | `opening_balance:load` |

  Pruebas: no se aplica **más que el saldo**, ni **dos veces la misma partida**, ni se cobra a un cliente distinto del de la factura; `reference` obligatoria en
  cheque/transferencia; un recibo contabilizado **no se edita** (se anula y se rehace); **anular dos veces es idempotente**; la cuenta de caja/banco se elige entre
  las cuentas con rol `cash`/`bank` (se leen por HTTP de contabilidad **fuera de la transacción**; caída → 502, no existe → 422).
- [x] **B.2 Anticipos:** el excedente queda como anticipo del cliente y el siguiente recibo puede aplicarlo a facturas nuevas.
- [x] **B.3 Asiento** (R.5) con su regla, su reversa y sus pruebas.
- [x] **B.4 UI** (`frontend/`, respetando `docs/UI-UX.md`: `PageHeader`, sin hexadecimales, sin `text-h1…h4`, iconos validados): `/treasury/receivables` (cartera con
      antigüedad, desde la que se cobra y se abre el recibo con las partidas del cliente cargadas), `/treasury/receipts` (lista y detalle con aplicaciones, anticipo, asiento,
      historial y «Anular» con motivo), y en la ficha del cliente «condiciones de crédito» y «estado de cuenta». Estados de carga, vacío y error en cada pantalla.
- [x] **B.5 Exportar** la cartera y el estado de cuenta (CSV) como los demás listados, **emitiendo `treasury.report.exported`** (R.4).
- [x] **B.6 Verificación en tres capas** (igual que compras): unitarias (dominio, casos de uso con repos en memoria incluyendo **aislamiento entre organizaciones**, **concurrencia por
      `version`** y **fallo a mitad de camino sin basura**, HTTP con permiso por ruta y 422 con nombre de campo); **MySQL real** con
      `scripts/verify-treasury.mjs` (copia `verify-purchasing.mjs`: importes exactos, **30 cobros simultáneos sin interbloqueos ni números repetidos**, restricciones `CHECK`,
      aislamiento); **navegador** (Playwright en `frontend/`) por el **gateway real**.

## 8. BLOQUE C — Estado de cuenta, antigüedad y recordatorios

- [x] Estado de cuenta imprimible/exportable, antigüedad por cliente, y **recordatorios** de cuentas vencidas por `notification-service` (evento `treasury.receivable.overdue`
      generado por un proceso diario **idempotente** por (partida, día); un recordatorio por partida y semana como máximo; **nunca** se manda al cliente sin que el
      Administrador haya activado la opción — es comunicación externa, requiere permiso explícito de la organización).
- [x] Etiquetas de bitácora y asyncapi de los eventos nuevos (R.4).

## 9. BLOQUES D y E — Se especifican, NO se empiezan hasta cerrar A, B y C en producción

### D — Cuentas por pagar y pagos (Fase 3.2)

- **D.1** Submayor de pagar: partidas desde `purchasing.bill.posted` (y `voided`), con vencimiento = fecha de emisión + días de crédito del proveedor (los días viven en
  `purchasing_db.suppliers.payment_term_days`; **se leen por evento o catálogo, no por SQL cruzado**).
- **D.2** Pagos `PG-AAAA-NNNNNN`, lotes de pago, cheques, antigüedad de deuda; misma máquina de estados y separación de funciones que los recibos (`payment:*`).
- **D.3** **Retención en la compra:** al llegar `fiscal.ec.withholding.issued` (RUC del proveedor + `support.number`), la retención **reduce la partida de ese proveedor**,
  cerrando el límite de §2. La partida se identifica **sin lanzar** si no existe (casi todas las retenciones son de compras que no pasaron por este módulo), solo
  actúa sobre facturas contabilizadas y es **idempotente**; contabilidad añade el tercero a «Dr proveedores» de la retención.
- **D.4** Asiento del pago: Dr `payables` (con el proveedor como tercero) → Cr `cash`/`bank`; anticipo a proveedor → `supplier_advances`.
- **D.5** Prueba de oro análoga: suma de saldos por proveedor = saldo de `payables` por tercero.

### E — Bancos, extractos y conciliación (Fase 3.3)

Cuentas bancarias de la organización, importación de extractos (formato CSV por banco, validado y con vista previa; **no se inventa el layout de un banco**: se pide un
ejemplo real), emparejamiento automático por importe/fecha/referencia con confirmación manual, conciliación por periodo con diferencia final, flujo de caja proyectado desde
cartera y deuda. Permisos `bank_account:manage`, `reconciliation:manage`; eventos auditados.

---

## 10. BLOQUE F — Despliegue y prueba funcional

Orden (un push a la rama principal despliega; **espera el CI en verde de cada uno antes del siguiente**):

1. `auth-service` (rama `master`): migración de permisos de R.1. Verifica el log del `initContainer` (`migrated`) y que el rol Contador vea lo nuevo.
2. `billing-service` solo si cambió algo.
3. `plugin-catalog-service` (rama `main`): migración del módulo (R.2). Ojo: su árbol tiene cambios ajenos de reservas; **sepáralos**.
4. `treasury-service` (rama `main`, **repo nuevo**: antes, §4 0.1 del dueño: repo, base, usuario, secretos).
5. `accounting-service` (rama `main`): reglas y canales de R.5.
6. `api-gateway-node` (rama `master`): variable y rutas de R.3.
7. `frontend` (rama `master`): pantallas.

**Después de desplegar, lecturas en el servidor** (`plink -m script.sh`, sin comillas anidadas): pods `Running` sin reinicios, log de cada `*-migrate`, y la bitácora
(`audit_db.audit_logs`, columna `event`) con los eventos nuevos.

**Prueba funcional en producción** (la lección de la Fase 2: *sin usuarios reales, no está probado*). Con el dueño y un usuario **Contador** reales, **cada uno con su
sesión que inicia él mismo** (no se introducen contraseñas por el agente):

1. Activar el módulo (el dueño) y comprobar que arrastra contabilidad.
2. Emitir una factura a crédito a un cliente de prueba → aparece la **partida abierta** con su vencimiento.
3. Cobro parcial → estado `partial`, asiento Dr caja / Cr clientes **con el cliente como tercero**, número `RC-…`.
4. Cobro de más → excedente como **anticipo**.
5. Estado de cuenta y antigüedad coinciden con el libro mayor (**prueba de oro**).
6. Anular el recibo (solo Administrador, con motivo) → reversa en contabilidad.
7. El Contador **ve** cartera y recibos, **no ve** «Anular» ni «Saldos iniciales».
8. **Bitácora:** cada paso aparece con su etiqueta legible, el actor y el detalle (motivo, importes, valor anterior/nuevo).
9. Barrido de pantallas (es/en/fr, móvil 390 px) y de iconos (`scripts/local-stack/barrido-pantallas.cjs`, `barrido-movil.cjs`, `barrido-iconos.cjs`) sin errores.

Lo que quede sin comprobar se dice por qué (no se marca).

---

## 11. Criterios de aceptación (casillas verificables)

- [ ] **0** Repo, base, secretos, CI y compose; `/health` responde en el stack y en el clúster.
- [ ] **R.1** Migración de permisos idempotente; `check-permissions.mjs --strict` en verde; 403/2xx por permiso; roles de lectura y contador incluidos.
- [ ] **R.2** Módulo `disponible`, con arista a `finance.general_ledger`, migración corrida dos veces sin duplicar, activable por API y UI.
- [ ] **R.3** Gateway: variable, servicio, rutas con plugin y permiso, prueba de rutas, y verificación por el gateway real (401/403/403/200 + cabeceras falsas).
- [ ] **R.4** Bitácora: dominio, etiquetas es/en/fr de **todos** los eventos, íconos/colores, payloads con lo importante, guardián de cobertura, `treasury.report.exported`.
- [ ] **R.5** Contabilidad: reglas, canales, reversa, `CURRENCY_MISMATCH`, pendientes, etiquetas de origen, pruebas.
- [ ] **R.6** Frontend base: navegación, rutas, tipos/api/store/utils con pruebas, i18n completo, botones por permiso, `lint:ui`/`typecheck`/`test`/`build` en verde.
- [ ] **A** Modelo, partidas idempotentes (incluye desorden y anulación), condiciones, saldos iniciales, listados, antigüedad, contrato, **prueba de oro**.
- [ ] **B** Recibos, anticipos, asiento, UI, exportación, tres capas de pruebas (incluidos 30 cobros simultáneos).
- [ ] **C** Estado de cuenta, antigüedad y recordatorios (con consentimiento).
- [ ] **D**, **E** (solo después de cerrar A–C en producción).
- [ ] **F** Despliegue en orden y prueba funcional con dos usuarios reales.
- [ ] **Docs:** `PLAN-ERP.md` (entrada en «Avance»), `COSAS-POR-HACER.md` (qué sube el dueño y en qué orden), `AGENTS.md` (servicio nuevo: carpeta/repo, rama `main`,
      puerto 3018, orden de despliegue), `IMPLEMENTATION-erp-fase-3.md` (marca lo hecho), `crm.dbml` de la bóveda + `verificar-dbml.mjs`, ficha del servicio en
      `~/Documents/sg-obs/crm-proyect/servicios/treasury-service.md`, y `docs/UI-UX.md` si tocaste un default.

---

## 12. Dónde está cada cosa (referencia, verificada el 2026-10-21)

| Qué | Dónde |
|---|---|
| Plantilla del servicio | `backend/purchasing-service` (`src/domain`, `application`, `infrastructure`, `interface/http`, `scripts/`, `k8s/`, `.github/workflows/deploy.yml`) |
| Dinero y redondeo | `purchasing-service/src/domain/money.ts` |
| Transacción `READ COMMITTED` | `purchasing-service/src/infrastructure/persistence/repositories.ts` (`begin({ readCommitted })`), usado en `PostBillUseCase` |
| Consumidor idempotente con desorden | `purchasing-service/src/application/use-cases/withholding-use-cases.ts` (`HandleWithholdingIssuedUseCase`) |
| Migración de permisos (patrón) | `auth-service/migrations/20261016140000-add-purchasing-permissions.js`; concesión a Contador/Solo lectura: `20261021120000-grant-…js` |
| Migración del módulo (patrón) | `plugin-catalog-service/migrations/20261016130000-enable-purchasing-plugins.cjs`; semillas en `plugin-catalog-service/seed/*.json` |
| Gateway: variables, servicios, rutas | `api-gateway-node/src/config/env.ts:30`, `gateway.config.ts:51` y `:213-235`, `k8s/deployment.yaml:~55`; pruebas `purchasing-routes.test.ts` |
| Reglas de asiento y roles | `accounting-service/src/domain/posting.ts` (`draftFromWithholdingIssued` l.274, `draftFromPurchaseBillPosted` l.420), `domain/account.ts:33`, `infrastructure/messaging/consumer.ts:11` |
| Bitácora (pantalla) | `frontend/src/views/audit/AuditLogView.vue` (lista `domains`, `eventLabel`, `iconFor`, `colorFor`); servicio `audit-log-service` (tabla `audit_logs`, columna `event`) |
| Navegación y rutas del frontend | `frontend/src/menus/navigation.ts` (entrada de compras l.31), `frontend/src/router/index.ts` |
| Compose local y bases | `docker-compose.yml` y `docker/mysql/init.sql` (raíz); pila desde `main`: `scripts/local-stack/` |
| Evento de facturación | `billing-service/asyncapi.yaml` (`billing.invoice.issued` l.24, `voided` l.121) |
| Cableado de producción | `COSAS-POR-HACER.md` (base, secretos, repo), `LEVANTAR-DESDE-CERO.md` |

## 13. Qué NO hace esta fase (a propósito)

- **Multimoneda con tipo de cambio** (otra fase): lo que no esté en la moneda base se bloquea con su motivo.
- **Cobro online / pasarela de pago** y cobro real del precio del módulo: los módulos se activan sin pagar hoy.
- **Cupo de crédito que bloquee la facturación:** el cupo se guarda y se muestra; bloquear `billing-service` es una decisión nueva del dueño.
- **Reproducir facturas históricas:** la cartera nace vacía; la única vía honesta es la carga de saldos iniciales.
- **Castigo masivo de cartera y provisión de incobrables:** el castigo es manual y por partida (`written_off`, con motivo); la provisión es de la Fase 7.
