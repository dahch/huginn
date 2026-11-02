# El badge de MCP deja de mentir cuando un servidor cae

> **Cómo usar este documento**
> 1. Como plan de huginn: `cp prompt-mcp-badge-honesto.md huginn/plan.mcp.md`, **commitea el plan**
>    (los worktrees solo ven archivos versionados) y lanza:
>    `huginn run --project . --plan plan.mcp.md --force-restart --profile rdd`.
> 2. Como brief de agente: pégalo entero. Es una sola iteración.
> 3. Los comandos de verificación usan `bun run` para resolver los bins locales: `vitest` a secas no
>    está en el `PATH` de `/bin/sh -c`.

---

## 1. Contexto: el síntoma exacto

Con dos servidores MCP configurados (`muninn` en el proyecto y `rea` + `muninn` en `~/.pi`), la TUI
mostró:

```
MCP: · none
```

y `/mcp` informó de `0/0 active · 0 tools`. El desencadenante fue `rea` fallando al arrancar
(`npx -y rea-agents@6.7.0 mcp`), que hace que `pi mcp list --json` no devuelva nada.

**Lo que ya está bien y no se toca:**

- El motor formatea el badge con `formatMcpBadge` (`src/engine/agent/mcpStatus.ts`), que ya tiene
  las ramas honestas: `🟡 error — <reason>`, `🟡 timeout`, `🟢 n connected`,
  `⚪ n configured` y `⚪ none`, todas con test.
- La TUI mapea ese texto a glifos de una columna (`mcpBadgeText` + `MCP_STATUS_GLYPHS`:
  `✓`/`!`/`·`) y colorea con `mcpStatusToken`. Nada de esto cambia.

**Lo que falta:** el informe. Cuando el listado del runtime falla o viene vacío,
`fetchMcpStatusWithTimeout` (`mcpStatus.ts:225-292`) cae al probe del driver:

```ts
const probeFn = source.mcpStatus ?? source.getMcpStatus;
if (!probeFn) {
  return { servers: [], totalTools: 0, healthy: false, unverified: true };
}
```

Y **solo `drivers/opencode.ts` implementa ese probe**. `drivers/pi-sdk.ts` implementa
`listMcpServers()` pero no `mcpStatus()`, así que con el listado caído el informe se queda en
`servers: []` → `MCP: ⚪ none`: «nada configurado» para dos servidores configurados.

El lector de config ya existe y ya está importado en el driver (`readMcpConfigFile`,
`pi-sdk.ts:18`); solo no se usa como respaldo.

---

## 2. Invariantes (no negociables)

1. **Nunca fabricar `connected`.** Un servidor leído de un archivo de configuración es
   `status: "unknown"` con `unverified: true`: Huginn no tiene cliente MCP para runtimes de
   subproceso y decir «conectado» sería la mentira inversa, la del badge siempre verde que este
   proyecto ya erradicó.
2. **Un servidor roto no borra a los sanos.** Si dos están configurados y uno falla, el informe
   enumera los dos y el badge nombra el fallo; `none` queda reservado para «no hay nada», que es
   un hecho distinto.
3. **La TUI no se toca.** `formatMcpBadge`, `mcpBadgeText` y `MCP_STATUS_GLYPHS` son el contrato;
   si el informe es correcto, el badge ya sale bien.
4. **Nada de emoji nuevo** ni cambios en los literales del gate.
5. Un commit, árbol verde, sin dependencias nuevas.

---

## 3. Alcance

**Dentro:** `src/engine/agent/drivers/pi-sdk.ts`, `src/engine/agent/mcpStatus.ts` (solo si hace
falta para la fusión listado+config), `src/engine/agent/types.ts` (solo si falta un campo),
`test/engine/agent/`, y la documentación.
**Fuera:** `src/tui/` entero, `src/cli.ts`, `src/commands/`, y cualquier cambio en `formatMcpBadge`
salvo que un test demuestre que una rama suya está mal.

---

## Iteration 1 — Un informe de MCP que enumera lo que hay, aunque no pueda sondearlo
modules: src/engine/agent/drivers/pi-sdk.ts, src/engine/agent/mcpStatus.ts, test/engine/agent/

**Goal:** Cuando el listado del runtime falla o llega vacío pero hay servidores en la configuración, el informe los enumera como `unknown`/`unverified` en vez de desaparecer, de modo que el badge diga `⚪ n configured` y nombre el servidor caído en lugar de `none`.

**Acceptance criteria:**
- El driver `pi` expone `mcpStatus()` (o el nombre que use `RuntimePort` para ese probe) que lee `~/.pi/agent/mcp.json` y `<project>/.pi/mcp.json` con `readMcpConfigFile` — la misma ruta y precedencia que ya usa la enumeración (el proyecto gana en colisión de nombres) — y devuelve un `McpStatusReport` con esos servidores en `status: "unknown"`, `unverified: true`, `healthy: false` y `totalTools: 0`.
- Con `rea` fallando y `muninn` sano (dos servidores en config, listado vacío) el badge resultante es `MCP: ⚪ 2 configured · pi` con `status: "unknown"`; **nunca** `none`.
- Si el listado **sí** devuelve entradas, sigue siendo la fuente de verdad (nada cambia en el camino feliz: `MCP: ✓ n connected · pi`), y los servidores que el listado no menciona se **añaden** desde la config como `unknown`, sin pisar los del listado.
- Si el listado trae un servidor en `error`, el informe sale `degraded` y el badge es `MCP: 🟡 error — <motivo> · pi` (o `🟡 timeout` si fue un deadline), conservando los demás servidores en `report.servers`.
- Sin configuración y sin listado, el badge sigue siendo `MCP: ⚪ none`, que es la verdad.
- `totalTools` no se inventa: si el listado no reporta herramientas, se queda en `0` y el badge no imprime `(0 tools)`.
- `/mcp` (la misma fuente) enumera los servidores configurados en vez de mostrar `0/0`.
- Tests en `test/engine/agent/`: (a) listado vacío + config con dos → `⚪ 2 configured`; (b) listado con uno en error + config con dos → `degraded` y el badge nombra el fallo sin perder el sano; (c) sin config ni listado → `⚪ none`; (d) listado sano con dos conexiones → sin cambios respecto a hoy.
- `bun run typecheck:test` sigue limpio: los fixtures nuevos se tipan, no se castean a `any`.

**Verification:**
```sh
bun test src
bun run vitest run
bun run typecheck
bun run typecheck:test
```

Notas de implementación:
1. El punto de composición correcto es el driver, no `formatMcpBadge`: el badge ya hace su trabajo con
   lo que le dan. Si te ves tocando `formatMcpBadge`, para y revisa de dónde sale el vacío.
2. No dupliques el lector: `readMcpConfigFile` ya está importado en `pi-sdk.ts`. Si necesitas
   precedencia, resuélvela ahí con un test que la fije.
3. `McpServerState` es `"connected" | "disconnected" | "unknown" | "error"`; `McpListingStatus` es
   `"connected" | "enabled" | "disabled" | "pending" | "error" | "unknown"`. La fusión debe mapear
   `enabled/disabled/pending/unknown → "unknown"` y `error → "error"`, nunca `→ "connected"`.
4. Documenta en el doc-comment del método **por qué** un servidor de config es `unknown`: es la
   diferencia entre «no lo sé» y «está roto», y es el corazón de este cambio.
5. Actualiza `AGENTS.md` (§5, el párrafo del driver `pi`) y `CHANGELOG.md` en el mismo commit: hoy
   el documento promete un fallback de config que el driver no tiene.

---

## 4. Definición de terminado

- `bun test src`, `bun run vitest run`, `bun run typecheck` y `bun run typecheck:test` en verde.
- Un commit con el porqué en el cuerpo; `CHANGELOG.md` bajo `Unreleased`; `AGENTS.md` §5 corregido.
- Ningún cambio en `src/tui/`: si el diff toca la TUI, el arreglo está en el sitio equivocado.

## 5. Verificación final

```sh
bun test src
bun run vitest run
bun run typecheck
bun run typecheck:test
bun run build
```

Y una comprobación manual con el `rea` todavía roto: `bun dist/cli.js live` debe pintar
`MCP: ⚪ 2 configured · pi` (o `! error — rea` si el listado llega a reportarlo), y `/mcp` debe
listar los dos servidores. Sin tocar la configuración de `rea`: el objetivo es que Huginn diga la
verdad **con** un servidor roto, no esperar a que lo arreglen.

## 6. Si algo no cuadra

- Si el listado de `pi` no devuelve **nada** y tampoco hay config legible en el sandbox, el informe
  debe decirlo con `unverified` y cero servidores — `none` es correcto ahí. No lo fuerces.
- Si `pi` implementa su propio probe en el futuro, este método suyo debe seguir existiendo como
  respaldo: el contrato es «nunca pierdas de vista lo que está configurado».
