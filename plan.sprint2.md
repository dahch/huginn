# Sprint 2 de la TUI: modales sin pictografías, cuervo legible y panel de salida que no esconde texto

> **Cómo usar este documento**
> 1. Como plan de huginn: `cp prompt-sprint2-ui-huginn.md huginn/plan.sprint2.md` y
>    `huginn run --project . --plan plan.sprint2.md --force-restart`.
> 2. Como brief de agente: pégalo entero. Las secciones 1-3 son obligatorias; las 4.x son las
>    iteraciones, en orden.
> 3. Los comandos de verificación resuelven los bins locales con `bun run`: `vitest` a secas no
>    está en el `PATH` de `/bin/sh -c`, y eso ya rompió un `VERIFY` en este repositorio.

---

## 1. Contexto

Dos runs han dejado la TUI en buena forma: tema semántico, cromo de tres niveles, modal de decisión
con presupuesto de filas, panel con secciones, navegación del transcript, markdown con ancho real,
cuervo con estados, una sola `Modal`, un solo hogar por dato y una matriz de humo que recorre los
tamaños canónicos.

Quedan cinco cosas. Cuatro son deuda reconocida; una es la que más se nota usando el producto a diario.

| ID | Hallazgo | Dónde |
|---|---|---|
| S-1 | Tres títulos de modal arrastran un emoji de doble ancho | `AgentPickerModal.tsx:136` (`🐦`), `HelpModal.tsx:118` (`📖`), `McpInspectorModal.tsx:226` (`🔌`) |
| S-2 | El estado del cuervo existe y está probado, pero no se ve | `RAVEN_MOODS` se cablea solo al `LiveHero`; `RavenHeader` acepta `mood` y nunca lo recibe (`RavenHeader.tsx:235`); `sleeping` no tiene disparador |
| S-3 | El panel de salida del run trunca cada línea con `…` y su scroll cuenta líneas, así que lo cortado es inalcanzable | `Dashboard.tsx:381-382,448-449` + `StreamCard` |
| S-4 | `tsconfig.json` compila solo `src`; `test/` nunca pasa por `tsc` | `tsconfig.json` → `"include": ["src"]` |
| S-5 | Las celdas de tabla no admiten markup inline (registrado como `todo`) | `tableBlock` en `markdown.tsx` |

La causa de S-1 es que la matriz de humo renderiza **los dos dashboards, no las modales**: el hueco
de cobertura coincide exactamente con el defecto. Por eso la iteración 1 arregla las dos cosas juntas.

---

## 2. Invariantes (no negociables)

1. **Sin cambios en `src/engine/`.** Ni para el badge, ni para el cuervo, ni para copiar.
2. **Ningún glifo de doble ancho en el cromo.** ASCII o una columna de `src/tui/glyphs.ts`. Los
   marcadores del productor (`⚡ ✓ ✗ 💭`) y los literales del gate (`### Overall gate: 🟢/🟡/🔴`,
   `⚠️ REVIEW REQUESTED`) son contratos: no se tocan.
3. **Una fila lógica = una fila de terminal.** Pre-envolver con `wrapSegments`, renderizar con
   `wrap="truncate"`. Un `wrap="wrap"` dentro de una tarjeta de altura fija es el bug histórico.
4. **El cromo se declara.** Alturas y anchos desde `cardChrome(...)` o constantes etiquetadas.
   Ningún literal nuevo de alto/ancho.
5. **Nada fabricado.** Dato ausente → fila ausente.
6. **Cada iteración deja el árbol verde** y un commit propio. Sin dependencias nuevas.
7. Las diez convenciones de `AGENTS.md` §8 siguen vigentes.

---

## 3. Alcance

**Dentro:** `src/tui/*`, `test/tui/*`, `src/tui/*.test.ts`, `tsconfig.test.json` (nuevo),
`package.json` (solo el script `typecheck:test`), documentación.
**Fuera:** `src/engine/`, `src/cli.ts`, `src/commands/`, `src/agents/`, y cualquier refactor no listado.

---

## 4. Iteraciones

## Iteration 1 — Las modales dejan de romper la rejilla, y la matriz las cubre
modules: src/tui/glyphs.ts, src/tui/AgentPickerModal.tsx, src/tui/HelpModal.tsx, src/tui/McpInspectorModal.tsx, test/tui/

**Goal:** Ningún título de modal lleva un pictografía de doble ancho, y la matriz de humo recorre también las modales, de modo que el hueco de cobertura que dejó pasar S-1 no vuelva a abrirse.

**Acceptance criteria:**
- `glyphs.ts` exporta `MODAL_TITLE_GLYPHS = { agent: ">", help: "?", inspector: "·" }`, incluido en el test guardián de glifos (una columna, ASCII, sin emoji).
- Los tres títulos quedan `> SELECT AGENT RUNTIME`, `? HUGINN LIVE CHEAT SHEET` y `· MCP SERVER INSPECTOR`, compuestos desde esa tabla — nunca con el glifo incrustado en el JSX.
- `test/tui/smokeMatrix.test.ts` monta las **siete** superficies modales (`AgentPickerModal`, `HelpModal`, `McpInspectorModal`, `ModelPickerModal`, `ProfilePickerModal`, `SkillsModal`, `DecisionModal`) en 80×24, 100×30 y 120×40 y, para cada frame, exige: ninguna línea excede `columns` en columnas de display, el frame no excede `rows`, ninguna línea contiene `\p{Extended_Pictographic}`, y la fila de título ocupa exactamente una línea.
- El test reutiliza los mocks que ya existen en `modelPicker.test.ts`, `agentPicker.test.ts`, `mcpInspector.test.ts`, `profilePicker.test.ts`, `skillsModal.test.ts` y `decisionModal.test.ts`; si una modal necesita un `initialReport` o un runtime falso, se pasa como prop — no se inventa un mock nuevo ni se toca la modal para hacerla testeable.
- `grep -rnP '[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]' src/tui` devuelve únicamente los marcadores del productor en `Dashboard.tsx` y el fixture de `clipboard.test.ts`.

**Verification:**
```sh
bun test src
bun run vitest run
bun run typecheck
```

Notas de implementación:
1. `SmokeMatrix` ya sabe medir y nombrar la fila infractora: extiéndelo con un parámetro de superficie, no dupliques el inspector.
2. El `✔` de `AgentPickerModal:158` es una columna y está bien; no lo toques. El problema son solo los títulos.
3. Actualiza `AGENTS.md` §8 (la deuda «recorded debt» deja de existir) y `CHANGELOG.md` en el mismo commit.

## Iteration 2 — El cuervo se ve
modules: src/brand.ts, src/tui/RavenHeader.tsx, src/tui/LiveDashboard.tsx, src/tui/Dashboard.tsx, src/brand.test.ts, test/tui/ravenHeader.test.ts, test/tui/liveLayout.test.ts

**Goal:** El estado del cuervo deja de ser un dato que existe y no se ve: sale en la cabecera, cambia de color con el estado y parpadea mientras hay un turno en vuelo, sin costar una sola fila ni columna.

**Acceptance criteria:**
- `ravenMark(mood, options?: { blink?: boolean })`: `blink` solo tiene efecto con `thinking`, y devuelve el mark de `idle` (ojo abierto), de modo que el ciclo de parpadeo alterna `<(O` ↔ `<(o` sin introducir glifos nuevos. Todas las variantes y todos los frames siguen siendo idénticos en filas y columnas.
- La cabecera del live pasa `mood` a `RavenHeader`: `thinking` mientras `busy`, `sleeping` cuando `mcpBadge.status === "degraded"`, `idle` en el resto. La precedencia es `busy` > `degraded` > `idle` y está en una función pura exportada (`ravenMood({ busy, degraded })`).
- `HeaderCard` del dashboard de ejecución hace lo mismo con su propio `spinnerIndex`.
- El color del mark sigue al estado: `THEME.muted` en `idle`, `THEME.accent` en `thinking`, `THEME.danger` en `sleeping`. Con `NO_COLOR` los tres resuelven a `undefined` y el glifo sigue distinguiendo el estado por sí solo.
- El parpadeo deriva del tick que ya existe (`spinnerIndex`, 80 ms): un ciclo de ~500 ms es `Math.floor(spinnerIndex / 6) % 2 === 1`. No se añade ningún `setInterval` nuevo.
- `LiveHero` recibe el mismo mood y el mismo blink, así que el cuervo grande y el de la cabecera nunca se contradicen.
- Tests: `brand.test.ts` comprueba que `blink` no altera la rejilla en ningún mood; `ravenHeader.test.ts`, que el color emitido corresponde al mood; `liveLayout.test.ts`, que con un turno en vuelo la cabecera pinta el mark de `thinking`.

**Verification:**
```sh
bun test src
bun run vitest run
bun run typecheck
```

Notas de implementación:
1. `RavenHeader` ya recibe `mood` y nadie se lo pasa: ese es el bug. Empieza por ahí y comprueba que con el cableado desnudo el ojo cambia antes de añadir color y parpadeo.
2. El mark se pinta hoy con `THEME.accentStrong` fijo; el color nuevo va en el mismo `<Text>`, no en un envoltorio.
3. Criterio de diseño que faltó la vez anterior: **todo indicador nuevo debe declarar cómo se ve cuando el usuario no está mirándolo**. Escríbelo en el doc-comment de `ravenMark`.

## Iteration 3 — El panel de salida deja de esconder texto
modules: src/tui/markdown.tsx, src/tui/Dashboard.tsx, src/tui/LiveDashboard.tsx, test/tui/

**Goal:** El panel de salida del run (y el del live) envuelve el texto en vez de cortarlo, su scroll cuenta filas de terminal, y el usuario puede leer el informe completo, copiarlo o darle toda la pantalla.

**Acceptance criteria:**
- `markdownBlockRows(lines, width, colorFor?)` es una función pura exportada en `markdown.tsx` que devuelve `MdSegment[][]`, **una entrada por fila de terminal**: expande los bloques de tabla con `tableBlock` y envuelve el resto con `wrapSegments(markdownSegments(line, color), width)`.
- `MarkdownBlock` se reimplementa sobre `markdownBlockRows`: una sola ruta de formateo para informe, stream y chat.
- `Dashboard` calcula `streamRows` con `useMemo([streamLines, bodyWidth])`, deriva `maxStreamScroll` de `streamRows.length` (no de `streamLines.length`), corta **filas** y pasa `rows` a `StreamCard`, que se vuelve un renderizador puro.
- La fila de título del panel muestra el indicador de scroll cuando hay contenido oculto: `▲ +N` si no estás al final, `▼ bottom` si lo estás, exactamente como la tarjeta de conversación.
- `z` en el dashboard de ejecución oculta la tarjeta de `PIPELINE` y da al panel de salida el ancho completo; `z` otra vez restaura el reparto. Con el foco en el panel, `y` copia el informe visible completo por OSC 52 con `copyToTerminal`.
- `ScrollableStreamCard` del live usa el mismo `markdownBlockRows` y las mismas cuentas: las dos superficies no pueden divergir.
- El buffer tiene tope (2 000 filas): más allá, se recorta por el principio y `maxScroll` no se dispara.
- Tests: una línea de 200 caracteres en un ancho de 40 produce ≥ 5 filas y `maxScroll === rows.length - visibleRows`; `z` cambia el ancho de la tarjeta; `y` emite exactamente una secuencia OSC 52.

**Verification:**
```sh
bun test src
bun run vitest run
bun run typecheck
```

Notas de implementación:
1. Envolver un informe de 60 KB en cada frame es inaceptable: `useMemo` sobre `[texto, ancho]` y nada más.
2. El color por línea de hoy (`l.startsWith("⚡") ? …`) se conserva: pásalo como `colorFor` y deja que `markdownBlockRows` lo aplique antes de envolver.
3. `y` debe copiar el texto del informe, no las filas envueltas (el portapapeles recibe el markdown original).
4. Si `z` deja el foco en una tarjeta que ya no se dibuja, mueve el foco como ya hace el live con la stream colapsada.

## Iteration 4 — `test/` entra en `tsc`
modules: tsconfig.test.json, package.json, test/, src/

**Goal:** El código de los tests compila con el typechecker estricto, de modo que un error como el `TS18046` que rompió una iteración anterior lo vea el desarrollador antes que el gate de contratos.

**Acceptance criteria:**
- Existe `tsconfig.test.json` que extiende `./tsconfig.json` con `"include": ["src", "test"]`, y `package.json` gana el script `"typecheck:test": "tsc -p tsconfig.test.json --noEmit"`.
- **Primero se mide**: el commit que añade la configuración incluye en su cuerpo el número de errores que reporta en árbol limpio (`bun run typecheck:test 2>&1 | grep -c 'error TS'`) y las rutas más afectadas.
- Si el recuento es **≤ 40**, se corrigen todos en esta iteración, en tandas por directorio y con el commit de cada tanda, hasta que `bun run typecheck:test` salga limpio; entonces sí se añade `typecheck:test` al script `test`/`prepublishOnly`.
- Si es **> 40**, se commitea la configuración y se documenta el recuento en el `CHANGELOG` como deuda con fecha; **no** se intenta arreglar en esta iteración ni se toca el script `typecheck` existente.
- `bun run typecheck` sigue compilando exactamente lo que compilaba antes: esta iteración no cambia la puerta que usa el pipeline.
- Ningún test se debilita para pasar: si un error de tipos revela un test mal escrito, se arregla el test, no el `tsconfig`.

**Verification:**
```sh
bun test src
bun run vitest run
bun run typecheck
```

Notas de implementación:
1. El riesgo real es que `test/` arrastre su propia configuración de tipos (`vitest/globals`, `bun:test`, DOM). Mide antes de decidir; no añadas `skipLibCheck` ni `strict: false` para salir del paso.
2. Prohibido el atajo de excluir archivos con `// @ts-nocheck`: si un archivo no compila, se arregla o se documenta el motivo exacto.

## Iteration 5 — Las celdas de tabla conservan su markup
modules: src/tui/markdown.tsx, test/tui/markdownTable.test.ts, test/tui/liveMarkdownTable.test.ts

**Goal:** Una tabla markdown de un informe de fase conserva el énfasis de sus celdas (`**bold**`, `code`) sin romper la alineación de columnas, y el `todo` que lo registraba desaparece.

**Acceptance criteria:**
- `tableBlock(rows, width)` devuelve `MdSegment[][]` (una fila de segmentos por fila de tabla) en vez de texto plano; el ancho de cada columna se calcula sobre el **texto visible** de cada celda (`stringWidth` del texto sin markup), nunca sobre el texto crudo.
- La cabecera sigue en bold; ` │ ` sigue dim; el truncado de una celda que no cabe termina en `…` y sigue ocupando una sola fila.
- `test/tui/markdownTable.test.ts` convierte su `todo` en una expectativa real: una tabla con `**Robustez**` y `npm audit` en una celda pinta el estilo y mantiene la alineación.
- En 100×30, una tabla de tres columnas con markup ocupa exactamente el mismo número de filas que la misma tabla sin markup.

**Verification:**
```sh
bun test src
bun run vitest run
bun run typecheck
```

Notas de implementación:
1. El markup se parsea con `inlineSegments` pero el ancho se mide con el texto plano resultante: son dos pasadas distintas y confundirlas es el bug obvio.
2. Si una celda mezcla markup y no cabe, se trunca el texto visible y se descarta el resto de segmentos: un estilo no puede sobrevivir a un corte.

---

## 5. Definición de terminado

- `bun test src`, `bun run vitest run` y `bun run typecheck` en verde; el árbol nunca se entrega rojo.
- Un commit por iteración con el porqué en el cuerpo; `CHANGELOG.md` con entrada bajo `Unreleased`.
- `AGENTS.md` §8 actualizado cuando cambie una convención (iteraciones 1, 2 y 3 la cambian).
- `ADR-N` para: el alfabeto de títulos de modal (S-1), el mood del cuervo como indicador con color y parpadeo (S-2) y el scroll por filas del panel de salida (S-3).
- Ningún literal nuevo de alto o ancho sin constante etiquetada o `cardChrome(...)`.

## 6. Verificación final

```sh
bun test src
bun run vitest run
bun run typecheck
bun run build
```

Y una pasada manual en el binario recién construido (`bun dist/cli.js live`): el cuervo debe abrir el
pico y cambiar de color mientras hay un turno, y en `huginn run` el panel de salida debe dejar leer una
línea larga hasta el final, admitir `z` y `y`, y mostrar `▲ +N` cuando quede texto por debajo.

## 7. Si algo no cuadra

- Si una iteración exige tocar `src/engine/` → **para** y reporta `archivo:línea` y por qué la TUI no
  puede resolverlo sola.
- Si la iteración 4 destapa más de 40 errores de tipos, no abras un frente: commitea la configuración,
  documenta el recuento y sigue con la 5.
- Si la matriz de humo falla al montar una modal por falta de props, **no** cambies la modal para
  hacerla testeable: añade la prop opcional con su valor por defecto y su test.
